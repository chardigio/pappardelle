import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {storeTest} from '../test/helpers/store-test.ts';
import {testState} from '../test/helpers/state.ts';
import {
	clearDeadRestartLock,
	isTuiDead,
	restartLockPath,
	tryRestartLock,
} from './tui-marker.ts';
import {createStateDaos} from './state-daos.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

const marker = {
	pid: 4242,
	cliPath: '/build/dist/cli.js',
	sha: 'abc1234',
	paneId: '%3',
	startedAt: 1_700_000_000_000,
};

storeTest(
	'a written marker reads back, and the later of two replaces the first',
	async state => {
		const {tuiMarker} = state.daos;
		expect(tuiMarker.read()).toBe(null);

		await tuiMarker.write(marker);
		expect(tuiMarker.read()).toStrictEqual(marker);

		const restarted = {
			...marker,
			pid: 4343,
			sha: 'def5678',
			startedAt: 1_700_000_005_000,
		};
		await tuiMarker.write(restarted);
		expect(tuiMarker.read()).toStrictEqual(restarted);
	},
);

storeTest(
	'a TUI is dead once the pid in its marker has exited',
	async state => {
		const {tuiMarker} = state.daos;
		expect(isTuiDead(tuiMarker, () => false)).toBe(false);

		await tuiMarker.write(marker);
		expect(isTuiDead(tuiMarker, pid => pid === 4242)).toBe(false);
		expect(isTuiDead(tuiMarker, () => false)).toBe(true);
	},
);

storeTest("one repo's marker is not another's", async state => {
	await state.daos.tuiMarker.write(marker);
	const other = createStateDaos({repo: 'other', stateDir: state.stateDir});
	expect(other.tuiMarker.read()).toBe(null);
	expect(state.daos.tuiMarker.read()).toStrictEqual(marker);
});

// `pappardelle restart` waits in one process for the marker the TUI writes
// in another.
test('a marker written by another process is read here', async () => {
	const state = testState();
	await exec(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
await createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}}).tuiMarker.write(${JSON.stringify(marker)});
`,
		],
		{timeout: 30_000},
	);
	expect(state.daos.tuiMarker.read()).toStrictEqual(marker);
});

test('the restart lock is exclusive until released', () => {
	const dir = tempDir('tui-marker-test-');
	const first = tryRestartLock(dir, 'app');
	expect(first.held).toBe(true);

	const second = tryRestartLock(dir, 'app');
	expect(second).toStrictEqual({held: false, holder: process.pid});

	if (first.held) first.release();
	expect(tryRestartLock(dir, 'app').held).toBe(true);
});

test('locks are per repo', () => {
	const dir = tempDir('tui-marker-test-');
	expect(tryRestartLock(dir, 'app').held).toBe(true);
	expect(tryRestartLock(dir, 'web').held).toBe(true);
});

test('a lock held by a dead process, or unreadable, is taken over', () => {
	const dir = tempDir('tui-marker-test-');
	fs.mkdirSync(path.join(dir, 'app'));

	fs.writeFileSync(restartLockPath(dir, 'app'), '777\n');
	expect(tryRestartLock(dir, 'app', () => false).held).toBe(true);
	expect(fs.readFileSync(restartLockPath(dir, 'app'), 'utf8')).toBe(
		`${process.pid}\n`,
	);

	fs.writeFileSync(restartLockPath(dir, 'app'), 'garbage');
	expect(tryRestartLock(dir, 'app', () => true).held).toBe(true);
});

test('a lock that cannot be created says why instead of throwing', () => {
	const dir = tempDir('tui-marker-test-');
	fs.writeFileSync(path.join(dir, 'app'), 'not a directory');

	const lock = tryRestartLock(dir, 'app');

	expect(lock.held).toBe(false);
	expect(lock.held ? '' : (lock.error ?? '')).toMatch(/^E(EXIST|NOTDIR)/);
});

test("a starting TUI clears its predecessor's lock but not a live restart's", () => {
	const dir = tempDir('tui-marker-test-');
	fs.mkdirSync(path.join(dir, 'app'));
	const file = restartLockPath(dir, 'app');

	fs.writeFileSync(file, '777\n');
	clearDeadRestartLock(dir, 'app', () => true);
	expect(fs.existsSync(file)).toBe(true);

	clearDeadRestartLock(dir, 'app', () => false);
	expect(fs.existsSync(file)).toBe(false);

	expect(() => {
		clearDeadRestartLock(dir, 'app');
	}).not.toThrow();
});
