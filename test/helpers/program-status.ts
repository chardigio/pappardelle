import fs from 'node:fs';
import {
	programStatusDir,
	programStatusPath,
	publishProgramSnapshot,
	type ProgramStatusSnapshot,
	type StatusPane,
} from '../../source/program-status-monitor.ts';
import {
	ProgramStatusStore,
	type ProgramReport,
	type ProgramStatusInfo,
} from '../../source/program-status.ts';
import {statusSocketPath} from '../../source/state-db.ts';
import type {TestState} from './state.ts';
import {deliver} from './status-daemon.ts';
import {waitUntil} from './wait.ts';

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
 * Publish `snapshot` as the monitor of a leased pane does in this state's
 * mode: its file, or with `sqlite` on a line to the status daemon. Returns
 * where the pane's file is, once the state's stores read what was published.
 */
export async function publishSnapshot(
	state: TestState,
	snapshot: ProgramStatusSnapshot,
): Promise<string> {
	if (!state.sqlite) return publishSnapshotFile(state, snapshot);
	grantLease(state, snapshot);
	const socketPath = statusSocketPath(state.stateDir);
	// The stores are pushed the snapshots of their own repo only.
	if (snapshot.repo !== state.repo) {
		await deliver(socketPath, {type: 'snapshot', snapshot});
		return snapshotFile(state, snapshot);
	}

	const store = state.daos.programStatus;
	// Connects the stores, so that what comes next is this snapshot's push.
	await store.read(snapshot.key, snapshot.pane);
	let pushed = false;
	const stop = store.watch(key => {
		if (key === snapshot.key) pushed = true;
	});
	try {
		await deliver(socketPath, {type: 'snapshot', snapshot});
		await waitUntil(
			() => pushed,
			`the snapshot of ${snapshot.key} to reach the stores`,
		);
	} finally {
		stop();
	}

	return snapshotFile(state, snapshot);
}

/** The status the state's stores read for a pane, if they read a snapshot. */
export async function readStatus(
	state: TestState,
	key: string,
	pane: StatusPane,
): Promise<ProgramStatusInfo['status'] | undefined> {
	const snapshot = await state.daos.programStatus.read(key, pane);
	return snapshot?.info.status;
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
