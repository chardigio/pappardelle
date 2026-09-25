import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
import {StartupQueue} from './startup-queue.ts';
import {runWorkspaceSetup} from './workspace-startup.ts';

function gate() {
	let release = () => {};
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return {promise, release};
}

test('burst startups yield between launches and never exceed two active setups', async t => {
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
	t.deepEqual(started, [0]);
	await nextTurn();
	t.deepEqual(started, [0, 1]);
	await nextTurn();
	t.deepEqual(started, [0, 1]);
	gates[0]!.release();
	await jobs[0];
	await nextTurn();
	t.deepEqual(started, [0, 1, 2]);
	for (const wait of gates) wait.release();
	await Promise.all(jobs);
	t.deepEqual(started, [0, 1, 2, 3, 4]);
	t.is(peak, 2);
});

test('failed process creation releases a queue slot without registering success', async t => {
	const queue = new StartupQueue(1);
	const completed: string[] = [];
	const failed = queue.enqueue(async () => {
		await runWorkspaceSetup('/missing/pappardelle-idow', [], {});
		completed.push('missing');
	});
	const failure = t.throwsAsync(failed, {code: 'ENOENT'});
	const next = queue.enqueue(async () => {
		const result = await runWorkspaceSetup(
			process.execPath,
			['-e', 'process.stdout.write("ready"); process.stderr.write("detail");'],
			{},
		);
		t.deepEqual(result, {
			code: 0,
			signal: null,
			stdout: 'ready',
			stderr: 'detail',
		});
		completed.push('next');
	});
	await failure;
	await next;
	t.deepEqual(completed, ['next']);
});

test('setup failures and signals are distinguishable from successful completion', async t => {
	const failed = await runWorkspaceSetup(
		process.execPath,
		['-e', 'process.exitCode = 7;'],
		{},
	);
	t.is(failed.code, 7);
	const killed = await runWorkspaceSetup(
		process.execPath,
		['-e', 'process.kill(process.pid, "SIGTERM");'],
		{},
	);
	t.is(killed.code, null);
	t.is(killed.signal, 'SIGTERM');
});

test('stopping the queue drops pending launches and lets active setup finish', async t => {
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
	t.deepEqual(started, ['active']);
});
