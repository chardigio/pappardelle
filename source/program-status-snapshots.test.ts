import {existsSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {
	publishSnapshot,
	readStatus,
	snapshotFile,
	snapshotOf,
} from '../test/helpers/program-status.ts';
import type {TestState} from '../test/helpers/state.ts';
import {until} from '../test/helpers/wait.ts';
import {
	parseStatusPane,
	programStatusDir,
	PublishWindow,
	type ProgramStatusSnapshot,
} from './program-status-monitor.ts';
import {statusSocketPath} from './state-db.ts';

const pane = (marker: string) =>
	parseStatusPane(`%1\t12\t0\t1\t${marker}`, 'test-status')!;
const old = pane('12.old');
const current = pane('12.current');
const working = [{state: 'working', id: '', app: 'fixture'}] as const;

/** The pane's snapshot once its store reads it as `expected`. */
async function eventually(
	read: () => Promise<ProgramStatusSnapshot | null>,
	expected: (snapshot: ProgramStatusSnapshot | null) => boolean,
): Promise<ProgramStatusSnapshot | null> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const snapshot = await read();
		if (expected(snapshot) || Date.now() > deadline) return snapshot;
		await delay(5);
	}
}

const leases = (state: TestState) =>
	readdirSync(programStatusDir('repo', state.stateDir))
		.filter(file => file.endsWith('.lease'))
		.sort();

contractTest(
	'a new generation prunes only its own key’s earlier generations',
	async state => {
		const store = state.daos.programStatus;
		const snapshots = {
			old: snapshotOf({repo: 'repo', key: 'STA-1', pane: old}, [...working]),
			current: snapshotOf({repo: 'repo', key: 'STA-1', pane: current}, [
				...working,
			]),
			sibling: snapshotOf({repo: 'repo', key: 'STA-2', pane: old}, [
				...working,
			]),
		};
		for (const snapshot of Object.values(snapshots))
			await publishSnapshot(state, snapshot);

		await store.remove('STA-1', current.generation);

		expect(leases(state)).toStrictEqual(
			[snapshots.current, snapshots.sibling]
				.map(
					snapshot => `${path.basename(snapshotFile(state, snapshot))}.lease`,
				)
				.sort(),
		);
		expect(existsSync(snapshotFile(state, snapshots.old))).toBe(false);
		expect(
			await eventually(
				async () => store.read('STA-1', old),
				snapshot => snapshot === null,
			),
		).toBe(null);
		expect(store.monitored('STA-1', old.generation)).toBe(false);
		expect(await readStatus(state, 'STA-1', current)).toBe('working');
		expect(store.monitored('STA-1', current.generation)).toBe(true);
		expect(await readStatus(state, 'STA-2', old)).toBe('working');
	},
);

contractTest(
	'closing a space removes every generation of its key and no other key',
	async state => {
		const store = state.daos.programStatus;
		for (const [key, generation] of [
			['STA-1', old],
			['STA-1', current],
			['STA-2', old],
		] as const)
			await publishSnapshot(
				state,
				snapshotOf({repo: 'repo', key, pane: generation}, [...working]),
			);

		await store.remove('STA-1');

		for (const generation of [old, current]) {
			expect(
				await eventually(
					async () => store.read('STA-1', generation),
					snapshot => snapshot === null,
				),
			).toBe(null);
			expect(store.monitored('STA-1', generation.generation)).toBe(false);
		}

		expect(await readStatus(state, 'STA-2', old)).toBe('working');
	},
);

contractTest(
	'a snapshot is read only for the pane and the repo it was published for',
	async state => {
		const store = state.daos.programStatus;
		await publishSnapshot(
			state,
			snapshotOf({repo: 'repo', key: 'STA-1', pane: current}, [...working]),
		);
		await publishSnapshot(
			state,
			snapshotOf({repo: 'other', key: 'STA-3', pane: current}, [...working]),
		);

		expect(await store.read('STA-1', current)).toMatchObject({
			repo: 'repo',
			key: 'STA-1',
			authoritative: true,
			exited: false,
			info: {status: 'working', app: 'fixture'},
		});
		expect(await store.read('STA-1', old)).toBe(null);
		expect(await store.read('STA-3', current)).toBe(null);
	},
);

// A reader checks a snapshot against the pane as tmux reports it now, which
// can have died since its monitor last published.
contractTest(
	'a working status is not read from a pane that has died, on any read, and a finished one is',
	async state => {
		const dead = {...current, dead: true};
		await publishSnapshot(
			state,
			snapshotOf({repo: 'repo', key: 'STA-1', pane: current}, [...working]),
		);

		for (let read = 0; read < 2; read++) {
			expect(await readStatus(state, 'STA-1', dead)).toBe('unknown');
			expect(await readStatus(state, 'STA-1', current)).toBe('working');
		}

		await publishSnapshot(
			state,
			snapshotOf({repo: 'repo', key: 'STA-1', pane: current}, [
				{state: 'done', id: '', app: 'fixture'},
			]),
		);
		expect(await readStatus(state, 'STA-1', dead)).toBe('done');
	},
);

contractTest(
	'a snapshot its monitor published on exit reads as exited, with no working status',
	async state => {
		const store = state.daos.programStatus;
		await publishSnapshot(
			state,
			snapshotOf({repo: 'repo', key: 'STA-1', pane: current}, [...working], {
				exited: true,
			}),
		);

		expect(await store.read('STA-1', current)).toMatchObject({
			exited: true,
			info: {status: 'unknown'},
		});
	},
);

contractTest(
	'a published snapshot reaches a watch with its space key, and ends a wait for a change',
	async state => {
		const store = state.daos.programStatus;
		const seen: string[] = [];
		teardown(store.watch(key => seen.push(key)));
		// A file watch that has just begun can miss a write made right after.
		await delay(50);
		const started = performance.now();
		const waiting = store.waitForChange(5000);

		await publishSnapshot(
			state,
			snapshotOf({repo: 'repo', key: 'STA-1', pane: current}, [...working]),
		);
		await waiting;

		expect(performance.now() - started < 4000).toBe(true);
		await until(() => seen.includes('STA-1'), {what: 'the watch to be told'});
		expect([...new Set(seen)]).toStrictEqual(['STA-1']);
	},
);

// A monitor outlives a change of experimental.sqliteState, so it is told
// where the status daemon listens even while the flag is off.
contractTest(
	'a monitor is started with the snapshot directory and the status socket',
	async state => {
		const commands: string[] = [];
		const pane = await state.daos.programStatus.attach(
			'STA-1',
			'agent-repo-STA-1',
			'test-status',
			async args => {
				commands.push(args.join(' '));
				return commands.length === 1
					? 'agent-repo-STA-1\t1\t\t%1\t12\t0\t0\t'
					: '';
			},
		);

		expect(pane).toBe(null);
		const launch = commands.find(command => command.includes('pipe-pane'));
		expect(launch?.includes(programStatusDir('repo', state.stateDir))).toBe(
			true,
		);
		expect(launch?.includes(statusSocketPath(state.stateDir))).toBe(true);
		expect(readdirSync(programStatusDir('repo', state.stateDir))).toStrictEqual(
			[],
		);
	},
);

/** A clock and a timer queue a test moves by hand. */
function fakeTimers() {
	let now = 0;
	let pending: {at: number; run: () => void} | undefined;
	return {
		now: () => now,
		after(ms: number, run: () => void) {
			pending = {at: now + ms, run};
			return () => {
				pending = undefined;
			};
		},
		advance(ms: number) {
			now += ms;
			if (pending && pending.at <= now) {
				const {run} = pending;
				pending = undefined;
				run();
			}
		},
		pendingAt: () => pending?.at,
	};
}

test('the first change after a quiet period is published at once', () => {
	const timers = fakeTimers();
	let published = 0;
	const publishing = new PublishWindow(() => published++, timers);

	publishing.request();
	expect(published).toBe(1);
	expect(timers.pendingAt()).toBe(undefined);

	timers.advance(50);
	publishing.request();
	expect(published).toBe(2);
});

test('changes within 50 ms of a publish go out together when that time is up', () => {
	const timers = fakeTimers();
	let published = 0;
	const publishing = new PublishWindow(() => published++, timers);

	publishing.request();
	for (const elapsed of [10, 10, 10]) {
		timers.advance(elapsed);
		publishing.request();
	}

	expect(published).toBe(1);
	expect(timers.pendingAt()).toBe(50);
	timers.advance(19);
	expect(published).toBe(1);
	timers.advance(1);
	expect(published).toBe(2);

	// The publish that closed the burst starts the next 50 ms.
	timers.advance(20);
	publishing.request();
	expect(published).toBe(2);
	expect(timers.pendingAt()).toBe(100);
});

test('a cancelled publish does not go out later', () => {
	const timers = fakeTimers();
	let published = 0;
	const publishing = new PublishWindow(() => published++, timers);

	publishing.request();
	timers.advance(10);
	publishing.request();
	publishing.cancel();
	timers.advance(100);
	expect(published).toBe(1);
});
