import {setImmediate as nextTurn} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {LatestTask} from './latest-task.ts';

test('teardown waits for active creation and cannot be superseded by a new selection', async () => {
	const task = new LatestTask();
	let release = () => {};
	const wait = new Promise<void>(resolve => {
		release = resolve;
	});
	const events: string[] = [];
	const attach = task.run(async () => {
		events.push('creating A');
		await wait;
		events.push('created A');
	});
	await nextTurn();
	task.cancel();
	const close = task.exclusive(async () => {
		events.push('killed A');
		await nextTurn();
		events.push('unregistered A');
	});
	const stale = task.run(async () => {
		events.push('attached B');
	});
	const latest = task.run(async () => {
		events.push('attached C');
	});
	await nextTurn();
	expect(events).toStrictEqual(['creating A']);
	release();
	await Promise.all([attach, close, stale, latest]);
	expect(events).toStrictEqual([
		'creating A',
		'created A',
		'killed A',
		'unregistered A',
		'attached C',
	]);
});

test('failed teardown releases the queue for a later attachment', async () => {
	const task = new LatestTask();
	await rejectionOf(
		task.exclusive(async () => {
			throw new Error('kill failed');
		}),
	);
	let attached = false;
	await task.run(async () => {
		attached = true;
	});
	expect(attached).toBe(true);
});

test('rapid selections finish the active operation before applying only the latest selection', async () => {
	const task = new LatestTask();
	let release = () => {};
	const wait = new Promise<void>(resolve => {
		release = resolve;
	});
	const events: string[] = [];
	const first = task.run(async signal => {
		events.push('A:start');
		await wait;
		expect(signal.aborted).toBe(true);
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
	expect(events).toStrictEqual(['A:start']);
	release();
	await Promise.all([first, second, third]);
	expect(events).toStrictEqual(['A:start', 'A:end', 'C']);
});

test('cancellation drains active work before teardown and skips pending work', async () => {
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
	expect(events).toStrictEqual([]);
	release();
	await close;
	expect(events).toStrictEqual(['created', 'deleted']);
});

test('a rejected switch does not prevent the next selection', async () => {
	const task = new LatestTask();
	await rejectionOf(
		task.run(async () => {
			throw new Error('tmux failed');
		}),
	);
	let attached = false;
	await task.run(async () => {
		attached = true;
	});
	expect(attached).toBe(true);
});
