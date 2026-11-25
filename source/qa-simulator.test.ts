import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
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

test('batches inventory, shares duplicate requests, and serializes simulator deletions', async () => {
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
	expect(
		await Promise.all([a, cleanup.delete('B'), cleanup.delete('MISSING')]),
	).toStrictEqual([true, true, true]);
	expect(peak).toBe(1);
	expect(await duplicate).toBe(true);
	expect(calls).toStrictEqual([
		['list', 'devices', '-j'],
		['delete', 'id-a'],
		['delete', 'id-b'],
	]);
});

test('new cleanup requests arriving during deletion run after the current batch', async () => {
	const calls: string[][] = [];
	let b: Promise<boolean> | undefined;
	const cleanup = new QaSimulatorCleanup(async args => {
		calls.push(args);
		if (args[0] === 'delete' && args[1] === 'id-a') b = cleanup.delete('B');
		return args[0] === 'list' ? inventory : '';
	});
	expect(await cleanup.delete('A')).toBe(true);
	expect(await b).toBe(true);
	expect(calls).toStrictEqual([
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
	test(`unavailable simulator support is cached briefly and then rechecked: ${error.message}`, async () => {
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
		expect(await cleanup.delete('MISSING')).toBe(true);
		expect(await cleanup.delete('MISSING')).toBe(true);
		expect(calls).toBe(1);
		now = 60_001;
		expect(await cleanup.delete('MISSING')).toBe(true);
		expect(calls).toBe(2);
	});
}

test('a failed deletion does not block the rest of the batch or a retry', async () => {
	let fail = true;
	const cleanup = new QaSimulatorCleanup(async args => {
		if (args[0] === 'list') return inventory;
		if (args[1] === 'id-a' && fail) throw new Error('device busy');
		return '';
	});
	expect(
		await Promise.all([cleanup.delete('A'), cleanup.delete('B')]),
	).toStrictEqual([false, true]);
	fail = false;
	expect(await cleanup.delete('A')).toBe(true);
});

test('inventory errors resolve every queued request and do not poison retries', async () => {
	let fail = true;
	const cleanup = new QaSimulatorCleanup(async () => {
		if (fail) throw new Error('simulator service unavailable');
		return inventory;
	});
	expect(
		await Promise.all([cleanup.delete('A'), cleanup.delete('B')]),
	).toStrictEqual([false, false]);
	fail = false;
	expect(await cleanup.delete('MISSING')).toBe(true);
});

test('queued cleanup skips a workspace that reopened while inventory was loading', async () => {
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
	expect(await cleanup.delete('A')).toBe(true);
	expect(calls).toStrictEqual([['list', 'devices', '-j']]);
});
