import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
import {LatestTask} from './latest-task.ts';

test('rapid selections finish the active operation before applying only the latest selection', async t => {
	const task = new LatestTask();
	let release = () => {};
	const wait = new Promise<void>(resolve => {
		release = resolve;
	});
	const events: string[] = [];
	const first = task.run(async signal => {
		events.push('A:start');
		await wait;
		t.true(signal.aborted);
		events.push('A:end');
	});
	await nextTurn();
	const second = task.run(async () => {
		events.push('B');
	});
	const third = task.run(async () => {
		events.push('C');
	});
	await nextTurn();
	t.deepEqual(events, ['A:start']);
	release();
	await Promise.all([first, second, third]);
	t.deepEqual(events, ['A:start', 'A:end', 'C']);
});

test('cancellation drains active work before teardown and skips pending work', async t => {
	const task = new LatestTask();
	let release = () => {};
	const wait = new Promise<void>(resolve => {
		release = resolve;
	});
	const events: string[] = [];
	void task.run(async () => {
		await wait;
		events.push('created');
	});
	await nextTurn();
	void task.run(async () => {
		events.push('stale');
	});
	task.cancel();
	const close = task.idle().then(() => {
		events.push('deleted');
	});
	await nextTurn();
	t.deepEqual(events, []);
	release();
	await close;
	t.deepEqual(events, ['created', 'deleted']);
});

test('a rejected switch does not prevent the next selection', async t => {
	const task = new LatestTask();
	await t.throwsAsync(
		task.run(async () => {
			throw new Error('tmux failed');
		}),
	);
	let attached = false;
	await task.run(async () => {
		attached = true;
	});
	t.true(attached);
});
