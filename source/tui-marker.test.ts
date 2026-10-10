import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	readTuiMarker,
	restartLockPath,
	tryRestartLock,
	tuiMarkerPath,
	writeTuiMarker,
} from './tui-marker.ts';

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

test('a written marker reads back, creating the repo state dir', t => {
	const dir = root();

	writeTuiMarker(dir, 'app', marker);

	t.deepEqual(readTuiMarker(dir, 'app'), marker);
	t.deepEqual(fs.readdirSync(path.join(dir, 'app')), ['tui.json']);
});

test('a missing, truncated or incomplete marker reads as none', t => {
	const dir = root();
	t.is(readTuiMarker(dir, 'app'), null);

	fs.mkdirSync(path.join(dir, 'app'));
	fs.writeFileSync(tuiMarkerPath(dir, 'app'), '{"pid": 42');
	t.is(readTuiMarker(dir, 'app'), null);

	fs.writeFileSync(tuiMarkerPath(dir, 'app'), JSON.stringify({pid: 42}));
	t.is(readTuiMarker(dir, 'app'), null);
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
