import {
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {SendLockTimeout, withSendLock} from './send-lock.ts';

function lockDir(t: {teardown: (fn: () => void) => void}) {
	const dir = mkdtempSync(path.join(tmpdir(), 'pappa-send-lock-'));
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	return dir;
}

async function recordSend(events: string[], name: string) {
	events.push(`${name} start`);
	await delay(30);
	events.push(`${name} end`);
}

test('sends to one session run one after another', async t => {
	const dir = lockDir(t);
	const events: string[] = [];
	await Promise.all([
		withSendLock('agent-r-STA-1', async () => recordSend(events, 'a'), {dir}),
		withSendLock('agent-r-STA-1', async () => recordSend(events, 'b'), {dir}),
	]);
	const [first] = events[0]!.split(' ');
	const second = first === 'a' ? 'b' : 'a';
	t.deepEqual(events, [
		`${first} start`,
		`${first} end`,
		`${second} start`,
		`${second} end`,
	]);
});

test('sends to different sessions do not wait for each other', async t => {
	const dir = lockDir(t);
	const events: string[] = [];
	await Promise.all([
		withSendLock('agent-r-STA-1', async () => recordSend(events, 'a'), {dir}),
		withSendLock('agent-r-STA-2', async () => recordSend(events, 'b'), {dir}),
	]);
	t.deepEqual(events.slice(0, 2).sort(), ['a start', 'b start']);
});

test('a failed send releases the lock', async t => {
	const dir = lockDir(t);
	await t.throwsAsync(
		withSendLock(
			'agent-r-STA-1',
			async () => {
				throw new Error('tmux died');
			},
			{dir},
		),
	);
	t.is(await withSendLock('agent-r-STA-1', async () => 'sent', {dir}), 'sent');
});

test('a lock left by a process that died is taken over', async t => {
	const dir = lockDir(t);
	writeFileSync(path.join(dir, 'agent-r-STA-1.lock'), '999999\n');
	const result = await withSendLock('agent-r-STA-1', async () => 'sent', {
		dir,
		isAlive: pid => pid !== 999_999,
	});
	t.is(result, 'sent');
});

test('a lock held by a live process times out instead of waiting forever', async t => {
	const dir = lockDir(t);
	writeFileSync(path.join(dir, 'agent-r-STA-1.lock'), '4242\n');
	await t.throwsAsync(
		withSendLock('agent-r-STA-1', async () => 'sent', {
			dir,
			isAlive: () => true,
			timeoutMs: 100,
		}),
		{instanceOf: SendLockTimeout},
	);
});

test('an empty lock file left by a crash is taken over once it is old', async t => {
	const dir = lockDir(t);
	const file = path.join(dir, 'agent-r-STA-1.lock');
	writeFileSync(file, '');
	const old = new Date(Date.now() - 60_000);
	utimesSync(file, old, old);
	const result = await withSendLock('agent-r-STA-1', async () => 'sent', {
		dir,
		timeoutMs: 500,
	});
	t.is(result, 'sent');
});

test('a sender that judged a lock stale leaves alone the fresh lock another sender took meanwhile', async t => {
	const dir = lockDir(t);
	const file = path.join(dir, 'agent-r-STA-1.lock');
	writeFileSync(file, '999999\n');
	await t.throwsAsync(
		withSendLock('agent-r-STA-1', async () => 'sent', {
			dir,
			timeoutMs: 100,
			isAlive(pid) {
				if (pid !== 999_999) return true;
				unlinkSync(file);
				writeFileSync(file, '4242\n');
				return false;
			},
		}),
		{instanceOf: SendLockTimeout},
	);
	t.is(readFileSync(file, 'utf8'), '4242\n');
});

test('a sender whose lock was taken over leaves the new holder lock in place', async t => {
	const dir = lockDir(t);
	const file = path.join(dir, 'agent-r-STA-1.lock');
	await withSendLock(
		'agent-r-STA-1',
		async () => {
			unlinkSync(file);
			writeFileSync(file, '4242\n');
		},
		{dir},
	);
	t.is(readFileSync(file, 'utf8'), '4242\n');
});

test('a lock held far past the send timeout is taken over even when its pid looks alive', async t => {
	const dir = lockDir(t);
	const file = path.join(dir, 'agent-r-STA-1.lock');
	writeFileSync(file, '4242\n');
	const old = new Date(Date.now() - 10 * 60_000);
	utimesSync(file, old, old);
	const result = await withSendLock('agent-r-STA-1', async () => 'sent', {
		dir,
		isAlive: () => true,
		timeoutMs: 500,
	});
	t.is(result, 'sent');
});
