import {
	setTimeout as delay,
	setImmediate as nextTurn,
} from 'node:timers/promises';
import test from 'ava';
import {PaneLayoutTask, syncTerminalDimensions} from './pane-layout-task.ts';
import {LatestTask} from './latest-task.ts';

test('rapid dialog changes coalesce and only the final geometry becomes ready', async t => {
	const queue = new LatestTask();
	const calls: boolean[] = [];
	const ready: boolean[] = [];
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 2);
	t.teardown(() => clearInterval(timer));
	const tasks = new PaneLayoutTask({
		queue,
		async apply(zoomed) {
			calls.push(zoomed);
			await delay(40);
			return {cols: zoomed ? 200 : 40, rows: 50};
		},
		onReady(zoomed) {
			ready.push(zoomed);
		},
		onError(error) {
			throw error;
		},
	});
	const first = tasks.request(true);
	await nextTurn();
	const pending = [
		tasks.request(false),
		tasks.request(true),
		tasks.request(false),
	];
	await Promise.all([first, ...pending]);
	t.deepEqual(calls, [true, false]);
	t.deepEqual(ready, [false]);
	t.true(ticks > 10);
});

test('reconstruction is serialized with attachment and cannot publish readiness after stop', async t => {
	const queue = new LatestTask();
	const events: string[] = [];
	let paneId = 'old';
	const tasks = new PaneLayoutTask({
		queue,
		async apply() {
			events.push('rebuild');
			await delay(20);
			paneId = 'new';
			return {cols: 40, rows: 50};
		},
		onReady() {
			events.push('ready');
		},
		onError(error) {
			throw error;
		},
	});
	const first = queue.run(async () => {
		events.push('attach old');
		await delay(20);
		events.push('attached old');
	});
	const layout = tasks.request(false);
	await nextTurn();
	const next = queue.run(async () => {
		events.push(`attach ${paneId}`);
	});
	await Promise.all([first, layout, next]);
	t.deepEqual(events, [
		'attach old',
		'attached old',
		'rebuild',
		'ready',
		'attach new',
	]);
	const stopped = tasks.request(true);
	await nextTurn();
	tasks.stop();
	await stopped;
	t.is(events.filter(event => event === 'ready').length, 1);
});

test('confirmed geometry reaches Ink resize listeners before dialog readiness', t => {
	const seen: number[] = [];
	const stream = {
		rows: 30,
		columns: 40,
		emit() {
			seen.push(this.columns);
			return true;
		},
	};
	syncTerminalDimensions(stream, {rows: 50, cols: 200});
	t.deepEqual(seen, [200]);
	syncTerminalDimensions(stream, {rows: 50, cols: 200});
	t.deepEqual(seen, [200]);
});

test('reopening during an unzoom gets fresh readiness even though the desired boolean repeats', async t => {
	const revisions: number[] = [];
	const task = new PaneLayoutTask({
		queue: new LatestTask(),
		async apply() {
			await delay(15);
			return {rows: 50, cols: 200};
		},
		onReady(_zoomed, _dimensions, revision) {
			revisions.push(revision);
		},
		onError(error) {
			throw error;
		},
	});
	await task.request(true, 1);
	const closing = task.request(false, 2);
	await nextTurn();
	const reopening = task.request(true, 3);
	t.deepEqual(revisions, [1]);
	await Promise.all([closing, reopening]);
	t.deepEqual(revisions, [1, 3]);
});

test('a request made while the queued rebuild waits behind an attachment is covered by that rebuild', async t => {
	const queue = new LatestTask();
	const calls: boolean[] = [];
	const task = new PaneLayoutTask({
		queue,
		async apply(zoomed) {
			calls.push(zoomed);
			return {rows: 50, cols: 200};
		},
		onReady() {},
		onError(error) {
			throw error;
		},
	});
	const attaching = queue.run(async () => delay(20));
	const first = task.request(true);
	await nextTurn();
	const second = task.request(false);
	await Promise.all([attaching, first, second]);
	t.deepEqual(calls, [false]);
});
