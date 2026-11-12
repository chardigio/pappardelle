import {readdirSync} from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {
	publishSnapshot,
	snapshotFile,
	snapshotOf,
} from '../test/helpers/program-status.ts';
import {
	parseStatusPane,
	programStatusDir,
	PublishWindow,
} from './program-status-monitor.ts';
import {stateDbPath} from './state-db.ts';

const pane = (marker: string) =>
	parseStatusPane(`%1\t12\t0\t1\t${marker}`, 'test-status')!;
const old = pane('12.old');
const current = pane('12.current');
const working = [{state: 'working', id: '', app: 'fixture'}] as const;

contractTest(
	'a new generation prunes only its own key’s earlier generations',
	async (t, state) => {
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
			publishSnapshot(state, snapshot);

		await store.remove('STA-1', current.generation);

		t.deepEqual(readdirSync(programStatusDir('repo', state.stateDir)).sort(), [
			path.basename(snapshotFile(state, snapshots.current)),
			`${path.basename(snapshotFile(state, snapshots.current))}.lease`,
			path.basename(snapshotFile(state, snapshots.sibling)),
			`${path.basename(snapshotFile(state, snapshots.sibling))}.lease`,
		]);
		t.is(store.read('STA-1', old), null);
		t.false(store.monitored('STA-1', old.generation));
		t.is(store.read('STA-1', current)?.info.status, 'working');
		t.true(store.monitored('STA-1', current.generation));
		t.is(store.read('STA-2', old)?.info.status, 'working');
	},
);

contractTest(
	'closing a space removes every generation of its key and no other key',
	async (t, state) => {
		const store = state.daos.programStatus;
		for (const [key, generation] of [
			['STA-1', old],
			['STA-1', current],
			['STA-2', old],
		] as const)
			publishSnapshot(
				state,
				snapshotOf({repo: 'repo', key, pane: generation}, [...working]),
			);

		await store.remove('STA-1');

		t.is(store.read('STA-1', old), null);
		t.is(store.read('STA-1', current), null);
		t.is(store.read('STA-2', old)?.info.status, 'working');
	},
);

contractTest(
	'a snapshot is read only for the pane and the repo it was published for',
	(t, state) => {
		const store = state.daos.programStatus;
		publishSnapshot(
			state,
			snapshotOf({repo: 'repo', key: 'STA-1', pane: current}, [...working]),
		);
		publishSnapshot(
			state,
			snapshotOf({repo: 'other', key: 'STA-3', pane: current}, [...working]),
		);

		t.like(store.read('STA-1', current), {
			repo: 'repo',
			key: 'STA-1',
			authoritative: true,
			exited: false,
			info: {status: 'working', app: 'fixture'},
		});
		t.is(store.read('STA-1', old), null);
		t.is(store.read('STA-3', current), null);
	},
);

// A monitor outlives a change of experimental.sqliteState, so it is told
// where the database is even while the flag is off.
contractTest(
	'a monitor is started with the snapshot directory and the database path',
	async (t, state) => {
		const commands: string[] = [];
		const pane = await state.daos.programStatus.attach(
			'STA-1',
			'agent-repo-STA-1',
			'test-status',
			async args => {
				commands.push(args.join(' '));
				return commands.length === 1 ? '\t%1\t12\t0\t0\t' : '';
			},
		);

		t.is(pane, null);
		const launch = commands.find(command => command.includes('pipe-pane'));
		t.true(launch?.includes(programStatusDir('repo', state.stateDir)));
		t.true(launch?.includes(stateDbPath(state.stateDir)));
		t.deepEqual(readdirSync(programStatusDir('repo', state.stateDir)), []);
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

test('the first change after a quiet period is published at once', t => {
	const timers = fakeTimers();
	let published = 0;
	const publishing = new PublishWindow(() => published++, timers);

	publishing.request();
	t.is(published, 1);
	t.is(timers.pendingAt(), undefined);

	timers.advance(50);
	publishing.request();
	t.is(published, 2);
});

test('changes within 50 ms of a publish go out together when that time is up', t => {
	const timers = fakeTimers();
	let published = 0;
	const publishing = new PublishWindow(() => published++, timers);

	publishing.request();
	for (const elapsed of [10, 10, 10]) {
		timers.advance(elapsed);
		publishing.request();
	}

	t.is(published, 1);
	t.is(timers.pendingAt(), 50);
	timers.advance(19);
	t.is(published, 1);
	timers.advance(1);
	t.is(published, 2);

	// The publish that closed the burst starts the next 50 ms.
	timers.advance(20);
	publishing.request();
	t.is(published, 2);
	t.is(timers.pendingAt(), 100);
});

test('a cancelled publish does not go out later', t => {
	const timers = fakeTimers();
	let published = 0;
	const publishing = new PublishWindow(() => published++, timers);

	publishing.request();
	timers.advance(10);
	publishing.request();
	publishing.cancel();
	timers.advance(100);
	t.is(published, 1);
});
