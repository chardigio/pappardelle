import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {QaSimulatorCleanup} from './qa-simulator.ts';

const inventory = JSON.stringify({
	devices: {
		runtime: [
			{name: 'QA-A', udid: 'id-a'},
			{name: 'QA-B', udid: 'id-b'},
			{name: 'Personal device', udid: 'keep-me'},
		],
	},
});

test('batches inventory, shares duplicate requests, and serializes simulator deletions', async t => {
	const calls: string[][] = [];
	let active = 0;
	let peak = 0;
	const cleanup = new QaSimulatorCleanup(async args => {
		calls.push(args);
		active++;
		peak = Math.max(peak, active);
		await delay(10);
		active--;
		return args[0] === 'list' ? inventory : '';
	});
	const a = cleanup.delete('A');
	const duplicate = cleanup.delete('A');
	t.deepEqual(
		await Promise.all([a, cleanup.delete('B'), cleanup.delete('MISSING')]),
		[true, true, true],
	);
	t.is(peak, 1);
	t.true(await duplicate);
	t.deepEqual(calls, [
		['list', 'devices', '-j'],
		['delete', 'id-a'],
		['delete', 'id-b'],
	]);
});

test('new cleanup requests arriving during deletion run after the current batch', async t => {
	const calls: string[][] = [];
	let b: Promise<boolean> | undefined;
	const cleanup = new QaSimulatorCleanup(async args => {
		calls.push(args);
		if (args[0] === 'delete' && args[1] === 'id-a') b = cleanup.delete('B');
		return args[0] === 'list' ? inventory : '';
	});
	t.true(await cleanup.delete('A'));
	t.true(await b);
	t.deepEqual(calls, [
		['list', 'devices', '-j'],
		['delete', 'id-a'],
		['list', 'devices', '-j'],
		['delete', 'id-b'],
	]);
});

for (const error of [
	Object.assign(new Error('missing xcrun'), {code: 'ENOENT'}),
	Object.assign(new Error('no Xcode'), {
		stderr: 'unable to find utility "simctl"',
	}),
]) {
	test(`unavailable simulator support is cached briefly and then rechecked: ${error.message}`, async t => {
		let calls = 0;
		let now = 0;
		const cleanup = new QaSimulatorCleanup(
			async () => {
				calls++;
				if (calls === 1) throw error;
				return inventory;
			},
			undefined,
			() => now,
		);
		t.true(await cleanup.delete('MISSING'));
		t.true(await cleanup.delete('MISSING'));
		t.is(calls, 1);
		now = 60_001;
		t.true(await cleanup.delete('MISSING'));
		t.is(calls, 2);
	});
}

test('a failed deletion does not block the rest of the batch or a retry', async t => {
	let fail = true;
	const cleanup = new QaSimulatorCleanup(async args => {
		if (args[0] === 'list') return inventory;
		if (args[1] === 'id-a' && fail) throw new Error('device busy');
		return '';
	});
	t.deepEqual(await Promise.all([cleanup.delete('A'), cleanup.delete('B')]), [
		false,
		true,
	]);
	fail = false;
	t.true(await cleanup.delete('A'));
});

test('inventory errors resolve every queued request and do not poison retries', async t => {
	let fail = true;
	const cleanup = new QaSimulatorCleanup(async () => {
		if (fail) throw new Error('simulator service unavailable');
		return inventory;
	});
	t.deepEqual(await Promise.all([cleanup.delete('A'), cleanup.delete('B')]), [
		false,
		false,
	]);
	fail = false;
	t.true(await cleanup.delete('MISSING'));
});

test('queued cleanup skips a workspace that reopened while inventory was loading', async t => {
	let reopened = false;
	const calls: string[][] = [];
	const cleanup = new QaSimulatorCleanup(
		async args => {
			calls.push(args);
			reopened = true;
			return inventory;
		},
		() => !reopened,
	);
	t.true(await cleanup.delete('A'));
	t.deepEqual(calls, [['list', 'devices', '-j']]);
});
