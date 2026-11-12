import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
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

test('deferring checkpoints waits for a store to open the database, then applies to that connection', async t => {
	const state = testState(t, {sqlite: true});
	const dbPath = stateDbPath(state.stateDir);

	state.daos.deferCheckpoints();
	t.false(fs.existsSync(dbPath));

	await state.daos.prLinkStamp.touch();
	t.is(autoCheckpointPages(dbPath), 0);
});

test('stores that were not asked to defer checkpoints keep SQLite’s own', async t => {
	const state = testState(t, {sqlite: true});
	await state.daos.prLinkStamp.touch();
	t.is(autoCheckpointPages(stateDbPath(state.stateDir)), 1000);
});

test('deferring checkpoints with the file-backed stores never creates a database', async t => {
	const state = testState(t, {sqlite: false});
	state.daos.deferCheckpoints();
	await state.daos.prLinkStamp.touch();
	t.false(fs.existsSync(stateDbPath(state.stateDir)));
});

// A CLI verb reads what a running daemon holds. Only the process that renders
// the TUI, and the pane monitors, start one. Serial: the daemon is started
// with this process's environment, and takes its log directory from HOME.
test.serial(
	'the stores start no status daemon until they are told this process may',
	async t => {
		const socketPath = testSocketPath(t);
		const stateDir = path.dirname(socketPath);
		const home = process.env['HOME'];
		process.env['HOME'] = stateDir;
		const daos = createStateDaos({repo: 'repo', stateDir, sqlite: true});
		const daemons = () => processesNaming('status-daemon-cli', socketPath);
		t.teardown(() => {
			process.env['HOME'] = home;
			daos.disconnectStatusDaemon();
			closeStateDb(stateDbPath(stateDir));
			killProcessesNaming(socketPath);
		});

		t.deepEqual(await daos.claudeStatus.readState('repo-STA-1'), {
			kind: 'none',
		});
		await daos.programStatus.remove('STA-1');
		t.deepEqual(daemons(), []);
		t.false(fs.existsSync(socketPath));

		daos.allowStatusDaemonStart();
		await waitUntil(
			() => fs.existsSync(socketPath) && daemons().length === 1,
			'the daemon to be started',
			30_000,
		);
	},
);

test('with the file-backed stores, allowing a status daemon starts none', async t => {
	const socketPath = testSocketPath(t);
	const stateDir = path.dirname(socketPath);
	const daos = createStateDaos({repo: 'repo', stateDir, sqlite: false});

	daos.allowStatusDaemonStart();
	t.deepEqual(await daos.claudeStatus.readState('repo-STA-1'), {
		kind: 'none',
	});
	await daos.programStatus.remove('STA-1');

	t.false(fs.existsSync(socketPath));
	t.deepEqual(processesNaming(socketPath), []);
});
