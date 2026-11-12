import fs from 'node:fs';
import {
	programStatusDir,
	programStatusPath,
	publishProgramSnapshot,
	type ProgramStatusSnapshot,
	type SnapshotRows,
	type StatusPane,
} from '../../source/program-status-monitor.ts';
import {SqliteSnapshotRows} from '../../source/program-status-sqlite.ts';
import {
	ProgramStatusStore,
	type ProgramReport,
} from '../../source/program-status.ts';
import {openStateDb, stateDbPath} from '../../source/state-db.ts';
import type {TestState} from './state.ts';

/** The snapshot a pane's monitor holds after `reports`. */
export function snapshotOf(
	target: {repo: string; key: string; pane: StatusPane},
	reports: ProgramReport[],
	overrides: Partial<ProgramStatusSnapshot> = {},
): ProgramStatusSnapshot {
	const store = new ProgramStatusStore();
	for (const report of reports) store.apply(report);
	return {
		version: 1,
		...target,
		authoritative: true,
		exited: false,
		updatedAt: Date.now(),
		records: store.records(),
		info: store.status(),
		...overrides,
	};
}

/** The snapshot file of a pane under the test's state directory. */
export function snapshotFile(
	state: TestState,
	snapshot: Pick<ProgramStatusSnapshot, 'repo' | 'key' | 'pane'>,
): string {
	return programStatusPath(
		programStatusDir(snapshot.repo, state.stateDir),
		snapshot.key,
		snapshot.pane.generation,
	);
}

/** The rows a monitor of this test's stores writes, or none without the database. */
export function snapshotRows(state: TestState): SnapshotRows | undefined {
	return state.sqlite
		? new SqliteSnapshotRows(() => openStateDb(stateDbPath(state.stateDir)))
		: undefined;
}

/** Give a pane its lease, as attaching its monitor does. */
export function grantLease(
	state: TestState,
	snapshot: Pick<ProgramStatusSnapshot, 'repo' | 'key' | 'pane'>,
): void {
	fs.mkdirSync(programStatusDir(snapshot.repo, state.stateDir), {
		recursive: true,
	});
	fs.writeFileSync(`${snapshotFile(state, snapshot)}.lease`, '');
}

/**
 * Publish `snapshot` as the monitor of a leased pane does, into the test's
 * stores, and return its file. `rows` stands in for the monitor's database.
 */
export function publishSnapshot(
	state: TestState,
	snapshot: ProgramStatusSnapshot,
	rows: SnapshotRows | undefined = snapshotRows(state),
): string {
	grantLease(state, snapshot);
	publishProgramSnapshot(
		programStatusDir(snapshot.repo, state.stateDir),
		snapshot,
		rows,
	);
	return snapshotFile(state, snapshot);
}

/** `publishSnapshot` by a monitor that writes files only. */
export function publishSnapshotFile(
	state: TestState,
	snapshot: ProgramStatusSnapshot,
): string {
	grantLease(state, snapshot);
	publishProgramSnapshot(
		programStatusDir(snapshot.repo, state.stateDir),
		snapshot,
	);
	return snapshotFile(state, snapshot);
}
