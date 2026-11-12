import {Database} from 'bun:sqlite';
import {spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {
	grantLease,
	publishSnapshot,
	publishSnapshotFile,
	snapshotFile,
	snapshotOf,
	snapshotRows,
} from '../test/helpers/program-status.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {
	parseStatusPane,
	programStatusDir,
	publishProgramSnapshot,
	type SnapshotRows,
} from './program-status-monitor.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const pane = parseStatusPane('%1\t12\t0\t1\t12.owner', 'test-status')!;
const target = {repo: 'repo', key: 'STA-1', pane};
const at = 1_800_000_000_000;

function rowStatuses(state: TestState): string[] {
	return openStateDb(stateDbPath(state.stateDir))
		.db.query<{info: string}, []>('SELECT info FROM program_status')
		.all()
		.map(row => (JSON.parse(row.info) as {status: string}).status);
}

test('a snapshot from a monitor that writes only files is read with the database', t => {
	const state = testState(t, {sqlite: true});
	publishSnapshotFile(
		state,
		snapshotOf(target, [{state: 'working', id: '', app: 'older-binary'}]),
	);

	t.deepEqual(rowStatuses(state), []);
	t.like(state.daos.programStatus.read('STA-1', pane), {
		info: {status: 'working', app: 'older-binary'},
	});
});

test('a row left behind while the database was off loses to a newer file', t => {
	const state = testState(t, {sqlite: true});
	publishSnapshot(
		state,
		snapshotOf(target, [{state: 'working', id: ''}], {updatedAt: at}),
	);
	publishSnapshotFile(
		state,
		snapshotOf(target, [{state: 'done', id: ''}], {updatedAt: at + 1000}),
	);

	t.deepEqual(rowStatuses(state), ['working']);
	t.is(state.daos.programStatus.read('STA-1', pane)?.info.status, 'done');
});

test('a row newer than its file is the one read', t => {
	const state = testState(t, {sqlite: true});
	publishSnapshot(
		state,
		snapshotOf(target, [{state: 'blocked', id: ''}], {updatedAt: at + 1000}),
	);
	publishSnapshotFile(
		state,
		snapshotOf(target, [{state: 'working', id: ''}], {updatedAt: at}),
	);

	t.is(state.daos.programStatus.read('STA-1', pane)?.info.status, 'blocked');
});

test('a row that its monitor could not have written is not read', t => {
	const state = testState(t, {sqlite: true});
	const snapshot = snapshotOf(target, [{state: 'working', id: ''}]);
	snapshot.info.status = 'blocked';
	const file = publishSnapshot(state, snapshot);
	writeFileSync(file, 'not a snapshot');

	t.deepEqual(rowStatuses(state), ['blocked']);
	t.is(state.daos.programStatus.read('STA-1', pane), null);
});

test('a publisher whose lease is revoked after it wrote its file leaves no file and no row', async t => {
	const state = testState(t, {sqlite: true});
	const store = state.daos.programStatus;
	const real = snapshotRows(state)!;
	let removal: Promise<void> | undefined;
	// The space is closed between the publisher's file write and its row
	// write: the lease, the file and the rows are already gone when the row
	// write starts.
	const revokedFirst: SnapshotRows = {
		publish(snapshot, leased) {
			removal = store.remove('STA-1');
			return real.publish(snapshot, leased);
		},
	};

	const file = publishSnapshot(
		state,
		snapshotOf(target, [{state: 'working', id: ''}]),
		revokedFirst,
	);
	await removal;

	t.false(existsSync(file));
	t.false(existsSync(`${file}.lease`));
	t.deepEqual(rowStatuses(state), []);
	t.is(store.read('STA-1', pane), null);
});

test('a revoked publisher deletes the row it published before', t => {
	const state = testState(t, {sqlite: true});
	const real = snapshotRows(state)!;
	const snapshot = snapshotOf(target, [{state: 'working', id: ''}]);
	publishSnapshot(state, snapshot);
	t.deepEqual(rowStatuses(state), ['working']);

	// Closed by a process without the database, which deletes files only.
	t.is(
		real.publish(snapshot, () => false),
		'written',
	);
	t.deepEqual(rowStatuses(state), []);
});

test('a publish that finds the database locked writes the file and asks to be retried', t => {
	const state = testState(t, {sqlite: true});
	const dbPath = stateDbPath(state.stateDir);
	const dir = programStatusDir('repo', state.stateDir);
	const snapshot = snapshotOf(target, [{state: 'working', id: ''}]);
	grantLease(state, snapshot);
	openStateDb(dbPath);
	const other = new Database(dbPath);
	t.teardown(() => {
		other.close();
	});

	other.run('BEGIN IMMEDIATE');
	t.is(publishProgramSnapshot(dir, snapshot, snapshotRows(state)), 'retry');
	t.true(existsSync(snapshotFile(state, snapshot)));
	t.deepEqual(rowStatuses(state), []);

	other.run('COMMIT');
	t.is(publishProgramSnapshot(dir, snapshot, snapshotRows(state)), 'done');
	t.deepEqual(rowStatuses(state), ['working']);
});

const monitorCli = fileURLToPath(
	new URL('program-status-monitor-cli.ts', import.meta.url),
);

async function until(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await delay(10);
	}
}

// A monitor lives as long as its agent pane, which can be days, and the flag
// can change in that time.
test('a running monitor starts and stops writing rows when the flag changes', async t => {
	const state = testState(t, {sqlite: true});
	const store = state.daos.programStatus;
	const home = path.join(state.stateDir, 'home');
	const flagFile = path.join(home, '.pappardelle', 'state-flag.json');
	const dbPath = stateDbPath(state.stateDir);
	const setFlag = (sqliteState: boolean) => {
		writeFileSync(flagFile, JSON.stringify({sqliteState, db: dbPath}));
	};

	mkdirSync(path.dirname(flagFile), {recursive: true});
	setFlag(false);
	const file = snapshotFile(state, target);
	grantLease(state, target);
	const env = {...process.env, HOME: home};
	Reflect.deleteProperty(env, 'PAPPARDELLE_SQLITE_STATE');
	const monitor = spawn(
		process.execPath,
		[
			monitorCli,
			'watch',
			'repo',
			'STA-1',
			'test-status',
			Buffer.from(JSON.stringify(pane)).toString('base64'),
			path.dirname(file),
			'',
			dbPath,
		],
		{stdio: ['pipe', 'ignore', 'inherit'], env},
	);
	t.teardown(() => {
		monitor.kill('SIGKILL');
	});
	const report = (status: string) => {
		monitor.stdin.write(`\u001B]7501;state=${status}:app=fixture\u0007`);
	};

	const fileShows = async (status: string) =>
		until(
			() => store.read('STA-1', pane)?.info.status === status,
			`file showing ${status}`,
		);

	report('working');
	await fileShows('working');
	t.deepEqual(rowStatuses(state), []);

	setFlag(true);
	await delay(1200);
	report('blocked');
	await until(
		() => rowStatuses(state)[0] === 'blocked',
		'row with the flag on',
	);

	setFlag(false);
	await delay(1200);
	report('done');
	await fileShows('done');
	t.deepEqual(rowStatuses(state), ['blocked']);
});
