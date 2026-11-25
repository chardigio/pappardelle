import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';
import {
	clearDeadRestartLock,
	isTuiDead,
	restartLockPath,
	tryRestartLock,
	tuiMarkerPath,
} from './tui-marker.ts';
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

const markerFile = (stateDir: string) =>
	tuiMarkerPath(path.join(stateDir, 'repos'), 'repo');

contractTest(
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
		expect(
			fs.readdirSync(path.dirname(markerFile(state.stateDir))),
		).toStrictEqual(['tui.json']);
	},
);

contractTest(
	'a TUI is dead once the pid in its marker has exited',
	async state => {
		const {tuiMarker} = state.daos;
		expect(isTuiDead(tuiMarker, () => false)).toBe(false);

		await tuiMarker.write(marker);
		expect(isTuiDead(tuiMarker, pid => pid === 4242)).toBe(false);
		expect(isTuiDead(tuiMarker, () => false)).toBe(true);
	},
);

contractTest(
	'a marker file written by hand is read, and a truncated, incomplete or removed one reads as none',
	async state => {
		const {tuiMarker} = state.daos;
		const file = markerFile(state.stateDir);
		await tuiMarker.write(marker);

		const byHand = {...marker, pid: 77, paneId: '%9'};
		fs.writeFileSync(file, JSON.stringify(byHand));
		expect(tuiMarker.read()).toStrictEqual(byHand);

		fs.writeFileSync(file, '{"pid": 42');
		expect(tuiMarker.read()).toBe(null);

		fs.writeFileSync(file, JSON.stringify({pid: 42}));
		expect(tuiMarker.read()).toBe(null);

		fs.writeFileSync(file, JSON.stringify(byHand));
		fs.rmSync(file);
		expect(tuiMarker.read()).toBe(null);
	},
);

contractTest("one repo's marker is not another's", async state => {
	await state.daos.tuiMarker.write(marker);
	const other = testState({repo: 'other', sqlite: state.sqlite});
	expect(other.daos.tuiMarker.read()).toBe(null);
});

// `pappardelle restart` waits in one process for the marker the TUI writes
// in another.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a marker written by another process is read here`, async () => {
		const state = testState({sqlite});
		await exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
await createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}, sqlite: ${sqlite}}).tuiMarker.write(${JSON.stringify(marker)});
`,
			],
			{timeout: 30_000},
		);
		expect(state.daos.tuiMarker.read()).toStrictEqual(marker);
	});
}

test('the two stores leave the same marker file', async () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState({sqlite});
		await state.daos.tuiMarker.write(marker);
		files.push(fs.readFileSync(markerFile(state.stateDir), 'utf8'));
	}

	expect(files[0]).toBe(files[1]);
	expect(files[0]).toBe(JSON.stringify(marker) + '\n');
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
