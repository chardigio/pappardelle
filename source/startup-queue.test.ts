import {setImmediate as nextTurn} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {StartupQueue, scheduleWorkspaceStart} from './startup-queue.ts';
import {runWorkspaceSetup} from './workspace-startup.ts';

function gate() {
	let release = () => {};
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return {promise, release};
}

test('burst startups yield between launches and never exceed two active setups', async () => {
	const queue = new StartupQueue();
	const gates = Array.from({length: 5}, () => gate());
	const started: number[] = [];
	let active = 0;
	let peak = 0;
	const jobs = gates.map(async (wait, index) =>
		queue.enqueue(async () => {
			started.push(index);
			peak = Math.max(peak, ++active);
			await wait.promise;
			active--;
		}),
	);
	await nextTurn();
	expect(started).toStrictEqual([0]);
	await nextTurn();
	expect(started).toStrictEqual([0, 1]);
	await nextTurn();
	expect(started).toStrictEqual([0, 1]);
	gates[0]!.release();
	await jobs[0];
	await nextTurn();
	expect(started).toStrictEqual([0, 1, 2]);
	for (const wait of gates) wait.release();
	await Promise.all(jobs);
	expect(started).toStrictEqual([0, 1, 2, 3, 4]);
	expect(peak).toBe(2);
});

test('failed process creation releases a queue slot without registering success', async () => {
	const queue = new StartupQueue(1);
	const completed: string[] = [];
	const failed = queue.enqueue(async () => {
		await runWorkspaceSetup('/missing/pappardelle-idow', [], {});
		completed.push('missing');
	});
	const failure = rejectionOf(failed);
	const next = queue.enqueue(async () => {
		const result = await runWorkspaceSetup(
			process.execPath,
			['-e', 'process.stdout.write("ready"); process.stderr.write("detail");'],
			{},
		);
		expect(result).toStrictEqual({
			code: 0,
			signal: null,
			stdout: 'ready',
			stderr: 'detail',
		});
		completed.push('next');
	});
	expect(await failure).toHaveProperty('code', 'ENOENT');
	await next;
	expect(completed).toStrictEqual(['next']);
});

test('setup failures and signals are distinguishable from successful completion', async () => {
	const failed = await runWorkspaceSetup(
		process.execPath,
		['-e', 'process.exitCode = 7;'],
		{},
	);
	expect(failed.code).toBe(7);
	const killed = await runWorkspaceSetup(
		process.execPath,
		['-e', 'process.kill(process.pid, "SIGTERM");'],
		{},
	);
	expect(killed.code).toBe(null);
	expect(killed.signal).toBe('SIGTERM');
});

test('stopping the queue drops pending launches and lets active setup finish', async () => {
	const queue = new StartupQueue(1);
	const wait = gate();
	const started: string[] = [];
	const active = queue.enqueue(async () => {
		started.push('active');
		await wait.promise;
	});
	const pending = queue.enqueue(async () => {
		started.push('pending');
	});
	await nextTurn();
	queue.stop();
	await pending;
	await queue.enqueue(async () => {
		started.push('late');
	});
	wait.release();
	await active;
	expect(started).toStrictEqual(['active']);
});

test('a user-started workspace does not wait behind a full watchlist queue', async () => {
	const queue = new StartupQueue(2);
	const blocked = Array.from({length: 4}, () => gate());
	const jobs = blocked.map(async wait =>
		scheduleWorkspaceStart(queue, async () => wait.promise, {queued: true}),
	);
	for (let i = 0; i < 3; i++) await nextTurn();
	let userStarted = false;
	const userJob = scheduleWorkspaceStart(
		queue,
		async () => {
			userStarted = true;
		},
		{queued: false},
	);
	expect(userStarted).toBe(true);
	await userJob;
	for (const wait of blocked) wait.release();
	await Promise.all(jobs);
});

test('watchlist starts still share the two queue slots', async () => {
	const queue = new StartupQueue(2);
	const blocked = Array.from({length: 3}, () => gate());
	const started: number[] = [];
	const jobs = blocked.map(async (wait, index) =>
		scheduleWorkspaceStart(
			queue,
			async () => {
				started.push(index);
				await wait.promise;
			},
			{queued: true},
		),
	);
	for (let i = 0; i < 3; i++) await nextTurn();
	expect(started).toStrictEqual([0, 1]);
	for (const wait of blocked) wait.release();
	await Promise.all(jobs);
	expect(started).toStrictEqual([0, 1, 2]);
});
