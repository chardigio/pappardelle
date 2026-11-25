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
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {SendLockTimeout, withSendLock} from './send-lock.ts';

function lockDir() {
	const dir = mkdtempSync(path.join(tmpdir(), 'pappa-send-lock-'));
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	return dir;
}

async function recordSend(events: string[], name: string) {
	events.push(`${name} start`);
	await delay(30);
	events.push(`${name} end`);
}

test('sends to one session run one after another', async () => {
	const dir = lockDir();
	const events: string[] = [];
	await Promise.all([
		withSendLock('agent-r-STA-1', async () => recordSend(events, 'a'), {dir}),
		withSendLock('agent-r-STA-1', async () => recordSend(events, 'b'), {dir}),
	]);
	const [first] = events[0]!.split(' ');
	const second = first === 'a' ? 'b' : 'a';
	expect(events).toStrictEqual([
		`${first} start`,
		`${first} end`,
		`${second} start`,
		`${second} end`,
	]);
});

test('sends to different sessions do not wait for each other', async () => {
	const dir = lockDir();
	const events: string[] = [];
	await Promise.all([
		withSendLock('agent-r-STA-1', async () => recordSend(events, 'a'), {dir}),
		withSendLock('agent-r-STA-2', async () => recordSend(events, 'b'), {dir}),
	]);
	expect(events.slice(0, 2).sort()).toStrictEqual(['a start', 'b start']);
});

test('a failed send releases the lock', async () => {
	const dir = lockDir();
	await rejectionOf(
		withSendLock(
			'agent-r-STA-1',
			async () => {
				throw new Error('tmux died');
			},
			{dir},
		),
	);
	expect(await withSendLock('agent-r-STA-1', async () => 'sent', {dir})).toBe(
		'sent',
	);
});

test('a lock left by a process that died is taken over', async () => {
	const dir = lockDir();
	writeFileSync(path.join(dir, 'agent-r-STA-1.lock'), '999999\n');
	const result = await withSendLock('agent-r-STA-1', async () => 'sent', {
		dir,
		isAlive: pid => pid !== 999_999,
	});
	expect(result).toBe('sent');
});

test('a stale lock whose takeover another sender holds times out instead of spinning', async () => {
	const dir = lockDir();
	writeFileSync(path.join(dir, 'agent-r-STA-1.lock'), '999999\n');
	writeFileSync(path.join(dir, 'agent-r-STA-1.lock.takeover'), '');
	await rejectionOf(
		withSendLock('agent-r-STA-1', async () => 'sent', {
			dir,
			isAlive: pid => pid !== 999_999,
			timeoutMs: 100,
		}),
		SendLockTimeout,
	);
});

test('a lock held by a live process times out instead of waiting forever', async () => {
	const dir = lockDir();
	writeFileSync(path.join(dir, 'agent-r-STA-1.lock'), '4242\n');
	await rejectionOf(
		withSendLock('agent-r-STA-1', async () => 'sent', {
			dir,
			isAlive: () => true,
			timeoutMs: 100,
		}),
		SendLockTimeout,
	);
});

test('an empty lock file left by a crash is taken over once it is old', async () => {
	const dir = lockDir();
	const file = path.join(dir, 'agent-r-STA-1.lock');
	writeFileSync(file, '');
	const old = new Date(Date.now() - 60_000);
	utimesSync(file, old, old);
	const result = await withSendLock('agent-r-STA-1', async () => 'sent', {
		dir,
		timeoutMs: 500,
	});
	expect(result).toBe('sent');
});

test('a sender that judged a lock stale leaves alone the fresh lock another sender took meanwhile', async () => {
	const dir = lockDir();
	const file = path.join(dir, 'agent-r-STA-1.lock');
	writeFileSync(file, '999999\n');
	await rejectionOf(
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
		SendLockTimeout,
	);
	expect(readFileSync(file, 'utf8')).toBe('4242\n');
});

test('a sender whose lock was taken over leaves the new holder lock in place', async () => {
	const dir = lockDir();
	const file = path.join(dir, 'agent-r-STA-1.lock');
	await withSendLock(
		'agent-r-STA-1',
		async () => {
			unlinkSync(file);
			writeFileSync(file, '4242\n');
		},
		{dir},
	);
	expect(readFileSync(file, 'utf8')).toBe('4242\n');
});

test('a lock held far past the send timeout is taken over even when its pid looks alive', async () => {
	const dir = lockDir();
	const file = path.join(dir, 'agent-r-STA-1.lock');
	writeFileSync(file, '4242\n');
	const old = new Date(Date.now() - 10 * 60_000);
	utimesSync(file, old, old);
	const result = await withSendLock('agent-r-STA-1', async () => 'sent', {
		dir,
		isAlive: () => true,
		timeoutMs: 500,
	});
	expect(result).toBe('sent');
});
