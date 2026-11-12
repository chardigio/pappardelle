import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';
import {
	clearDeadRestartLock,
	isTuiDead,
	restartLockPath,
	tryRestartLock,
	tuiMarkerPath,
} from './tui-marker.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

function root(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'tui-marker-test-'));
}

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
	async (t, state) => {
		const {tuiMarker} = state.daos;
		t.is(tuiMarker.read(), null);

		await tuiMarker.write(marker);
		t.deepEqual(tuiMarker.read(), marker);

		const restarted = {
			...marker,
			pid: 4343,
			sha: 'def5678',
			startedAt: 1_700_000_005_000,
		};
		await tuiMarker.write(restarted);
		t.deepEqual(tuiMarker.read(), restarted);
		t.deepEqual(fs.readdirSync(path.dirname(markerFile(state.stateDir))), [
			'tui.json',
		]);
	},
);

contractTest(
	'a TUI is dead once the pid in its marker has exited',
	async (t, state) => {
		const {tuiMarker} = state.daos;
		t.false(isTuiDead(tuiMarker, () => false));

		await tuiMarker.write(marker);
		t.false(isTuiDead(tuiMarker, pid => pid === 4242));
		t.true(isTuiDead(tuiMarker, () => false));
	},
);

contractTest(
	'a marker file written by hand is read, and a truncated, incomplete or removed one reads as none',
	async (t, state) => {
		const {tuiMarker} = state.daos;
		const file = markerFile(state.stateDir);
		await tuiMarker.write(marker);

		const byHand = {...marker, pid: 77, paneId: '%9'};
		fs.writeFileSync(file, JSON.stringify(byHand));
		t.deepEqual(tuiMarker.read(), byHand);

		fs.writeFileSync(file, '{"pid": 42');
		t.is(tuiMarker.read(), null);

		fs.writeFileSync(file, JSON.stringify({pid: 42}));
		t.is(tuiMarker.read(), null);

		fs.writeFileSync(file, JSON.stringify(byHand));
		fs.rmSync(file);
		t.is(tuiMarker.read(), null);
	},
);

contractTest("one repo's marker is not another's", async (t, state) => {
	await state.daos.tuiMarker.write(marker);
	const other = testState(t, {repo: 'other', sqlite: state.sqlite});
	t.is(other.daos.tuiMarker.read(), null);
});

// `pappardelle restart` waits in one process for the marker the TUI writes
// in another.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a marker written by another process is read here`, async t => {
		const state = testState(t, {sqlite});
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
		t.deepEqual(state.daos.tuiMarker.read(), marker);
	});
}

test('the two stores leave the same marker file', async t => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState(t, {sqlite});
		await state.daos.tuiMarker.write(marker);
		files.push(fs.readFileSync(markerFile(state.stateDir), 'utf8'));
	}

	t.is(files[0], files[1]);
	t.is(files[0], JSON.stringify(marker) + '\n');
});

test('the restart lock is exclusive until released', t => {
	const dir = root();
	const first = tryRestartLock(dir, 'app');
	t.true(first.held);

	const second = tryRestartLock(dir, 'app');
	t.deepEqual(second, {held: false, holder: process.pid});

	if (first.held) first.release();
	t.true(tryRestartLock(dir, 'app').held);
});

test('locks are per repo', t => {
	const dir = root();
	t.true(tryRestartLock(dir, 'app').held);
	t.true(tryRestartLock(dir, 'web').held);
});

test('a lock held by a dead process, or unreadable, is taken over', t => {
	const dir = root();
	fs.mkdirSync(path.join(dir, 'app'));

	fs.writeFileSync(restartLockPath(dir, 'app'), '777\n');
	t.true(tryRestartLock(dir, 'app', () => false).held);
	t.is(
		fs.readFileSync(restartLockPath(dir, 'app'), 'utf8'),
		`${process.pid}\n`,
	);

	fs.writeFileSync(restartLockPath(dir, 'app'), 'garbage');
	t.true(tryRestartLock(dir, 'app', () => true).held);
});

test('a lock that cannot be created says why instead of throwing', t => {
	const dir = root();
	fs.writeFileSync(path.join(dir, 'app'), 'not a directory');

	const lock = tryRestartLock(dir, 'app');

	t.false(lock.held);
	t.regex(lock.held ? '' : (lock.error ?? ''), /^E(EXIST|NOTDIR)/);
});

test("a starting TUI clears its predecessor's lock but not a live restart's", t => {
	const dir = root();
	fs.mkdirSync(path.join(dir, 'app'));
	const file = restartLockPath(dir, 'app');

	fs.writeFileSync(file, '777\n');
	clearDeadRestartLock(dir, 'app', () => true);
	t.true(fs.existsSync(file));

	clearDeadRestartLock(dir, 'app', () => false);
	t.false(fs.existsSync(file));

	t.notThrows(() => {
		clearDeadRestartLock(dir, 'app');
	});
});
