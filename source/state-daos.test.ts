import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {
	killProcessesNaming,
	processesNaming,
} from '../test/helpers/processes.ts';
import {testState} from '../test/helpers/state.ts';
import {testSocketPath} from '../test/helpers/status-daemon.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {createStateDaos} from './state-daos.ts';
import {closeStateDb, openStateDb, stateDbPath} from './state-db.ts';

const autoCheckpointPages = (dbPath: string) =>
	openStateDb(dbPath)
		.db.query<{wal_autocheckpoint: number}, []>('PRAGMA wal_autocheckpoint')
		.get()?.wal_autocheckpoint;

test('deferring checkpoints waits for a store to open the database, then applies to that connection', async () => {
	const state = testState({sqlite: true});
	const dbPath = stateDbPath(state.stateDir);

	state.daos.deferCheckpoints();
	expect(fs.existsSync(dbPath)).toBe(false);

	await state.daos.prLinkStamp.touch();
	expect(autoCheckpointPages(dbPath)).toBe(0);
});

test('stores that were not asked to defer checkpoints keep SQLite’s own', async () => {
	const state = testState({sqlite: true});
	await state.daos.prLinkStamp.touch();
	expect(autoCheckpointPages(stateDbPath(state.stateDir))).toBe(1000);
});

test('deferring checkpoints with the file-backed stores never creates a database', async () => {
	const state = testState({sqlite: false});
	state.daos.deferCheckpoints();
	await state.daos.prLinkStamp.touch();
	expect(fs.existsSync(stateDbPath(state.stateDir))).toBe(false);
});

// A CLI verb reads what a running daemon holds. Only the process that renders
// the TUI, and the pane monitors, start one. Serial: the daemon is started
// with this process's environment, and takes its log directory from HOME.
test('the stores start no status daemon until they are told this process may', async () => {
	const socketPath = testSocketPath();
	const stateDir = path.dirname(socketPath);
	const home = process.env['HOME'];
	process.env['HOME'] = stateDir;
	const daos = createStateDaos({repo: 'repo', stateDir, sqlite: true});
	const daemons = () => processesNaming('status-daemon-cli', socketPath);
	teardown(() => {
		process.env['HOME'] = home;
		daos.disconnectStatusDaemon();
		closeStateDb(stateDbPath(stateDir));
		killProcessesNaming(socketPath);
	});

	expect(await daos.claudeStatus.readState('repo-STA-1')).toStrictEqual({
		kind: 'none',
	});
	await daos.programStatus.remove('STA-1');
	expect(daemons()).toStrictEqual([]);
	expect(fs.existsSync(socketPath)).toBe(false);

	daos.allowStatusDaemonStart();
	await waitUntil(
		() => fs.existsSync(socketPath) && daemons().length === 1,
		'the daemon to be started',
		30_000,
	);
});

test('with the file-backed stores, allowing a status daemon starts none', async () => {
	const socketPath = testSocketPath();
	const stateDir = path.dirname(socketPath);
	const daos = createStateDaos({repo: 'repo', stateDir, sqlite: false});

	daos.allowStatusDaemonStart();
	expect(await daos.claudeStatus.readState('repo-STA-1')).toStrictEqual({
		kind: 'none',
	});
	await daos.programStatus.remove('STA-1');

	expect(fs.existsSync(socketPath)).toBe(false);
	expect(processesNaming(socketPath)).toStrictEqual([]);
});
