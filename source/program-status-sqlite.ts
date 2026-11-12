// Program status snapshots as rows, with each snapshot file kept beside its
// row.
//
// A monitor writes its file and then its row, up to 20 times a second, so
// this store keeps no json_sync record and imports nothing. A reader takes
// whichever of the two is newer: a monitor started by a binary from before
// the database writes only files, and a row is left behind while the flag is
// off. Leases stay files, because a process without the database has to be
// able to revoke one.

import {createLogger} from './logger.ts';
import {
	attachStatusMonitor,
	checkedProgramSnapshot,
	JsonProgramStatusDao,
	programStatusDir,
	type ProgramStatusDao,
	type ProgramStatusSnapshot,
	type SnapshotRows,
	type StatusPane,
	type StatusTmuxRunner,
} from './program-status-monitor.ts';
import {GuardedReads, isBusyError, type StateDb} from './state-db.ts';
import {onStateDbChange, waitForStateDbChange} from './state-db-watch.ts';

const log = createLogger('program-status');

type SnapshotRow = {
	repo: string;
	key: string;
	generation: string;
	pane_id: string;
	pane_pid: string;
	pane_dead: number;
	pane_piped: number;
	marker: string;
	authoritative: number;
	exited: number;
	updated_at: number;
	records: string;
	info: string;
};

type SnapshotVersion = {key: string; content: string};

const COLUMNS =
	'repo, key, generation, pane_id, pane_pid, pane_dead, pane_piped, marker, authoritative, exited, updated_at, records, info';

function toSnapshot(row: SnapshotRow): ProgramStatusSnapshot {
	return {
		version: 1,
		repo: row.repo,
		key: row.key,
		pane: {
			id: row.pane_id,
			pid: row.pane_pid,
			dead: row.pane_dead === 1,
			piped: row.pane_piped === 1,
			marker: row.marker,
			generation: row.generation,
		},
		authoritative: row.authoritative === 1,
		exited: row.exited === 1,
		updatedAt: row.updated_at,
		records: JSON.parse(row.records) as ProgramStatusSnapshot['records'],
		info: JSON.parse(row.info) as ProgramStatusSnapshot['info'],
	};
}

export class SqliteSnapshotRows implements SnapshotRows {
	private failing = false;

	constructor(private readonly openDb: () => StateDb) {}

	publish(
		snapshot: ProgramStatusSnapshot,
		leased: () => boolean,
	): 'written' | 'busy' | 'failed' {
		try {
			const state = this.openDb();
			// Removal deletes the lease before the rows. Looking at the lease
			// while holding the write lock means a removal either ran before
			// this and is seen here, or deletes the row this writes.
			state.tryWriteRows(() => {
				if (leased()) put(state, snapshot);
				else {
					state.db
						.query(
							'DELETE FROM program_status WHERE repo = ? AND key = ? AND generation = ?',
						)
						.run(snapshot.repo, snapshot.key, snapshot.pane.generation);
				}
			});
			this.failing = false;
			return 'written';
		} catch (error) {
			if (isBusyError(error)) return 'busy';
			// A monitor publishes up to 20 times a second, so a database that
			// stays unusable is reported once, not on every write.
			if (!this.failing) {
				this.failing = true;
				log.warn(
					'Could not write a program status to the state database',
					error instanceof Error ? error : undefined,
				);
			}

			return 'failed';
		}
	}
}

function put(state: StateDb, snapshot: ProgramStatusSnapshot): void {
	const {pane} = snapshot;
	state.db
		.query(
			`INSERT OR REPLACE INTO program_status (${COLUMNS})
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			snapshot.repo,
			snapshot.key,
			pane.generation,
			pane.id,
			pane.pid,
			pane.dead ? 1 : 0,
			pane.piped ? 1 : 0,
			pane.marker,
			snapshot.authoritative ? 1 : 0,
			snapshot.exited ? 1 : 0,
			snapshot.updatedAt,
			JSON.stringify(snapshot.records),
			JSON.stringify(snapshot.info),
		);
}

export class SqliteProgramStatusDao implements ProgramStatusDao {
	readonly repo: string;
	readonly dir: string;
	readonly dbPath: string;
	private readonly reads = new GuardedReads(log, 'program statuses');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly json: JsonProgramStatusDao,
	) {
		this.repo = json.repo;
		this.dir = json.dir;
		this.dbPath = json.dbPath;
	}

	async attach(
		key: string,
		session: string,
		socket?: string,
		run?: StatusTmuxRunner,
	): Promise<StatusPane | null> {
		return attachStatusMonitor(this, key, session, socket, run);
	}

	monitored(key: string, generation: string): boolean {
		return this.json.monitored(key, generation);
	}

	read(key: string, pane: StatusPane): ProgramStatusSnapshot | null {
		const file = this.json.read(key, pane);
		const row = this.readRow(key, pane);
		if (!row) return file;
		return file && file.updatedAt >= row.updatedAt ? file : row;
	}

	async remove(key: string, keepGeneration?: string): Promise<void> {
		this.json.removeFiles(key, keepGeneration);
		try {
			await this.openDb().writeRows(() => {
				this.openDb()
					.db.query(
						`DELETE FROM program_status
						WHERE repo = ? AND key = ? AND generation IS NOT ?`,
					)
					.run(this.repo, key, keepGeneration ?? null);
			});
		} catch (error) {
			// The rows left behind belong to panes that are gone, and no reader
			// asks for a pane that is gone.
			log.warn(
				`Could not delete the program status rows of ${key}`,
				error instanceof Error ? error : undefined,
			);
		}
	}

	watch(listener: (key: string) => void): () => void {
		let known = this.reads.or(new Map<string, SnapshotVersion>(), () =>
			this.versions(),
		);
		return onStateDbChange(this.dbPath, () => {
			const current = this.reads.or(null, () => this.versions());
			if (!current) return;
			const changed = new Set<string>();
			for (const id of new Set([...known.keys(), ...current.keys()])) {
				const [before, after] = [known.get(id), current.get(id)];
				if (before?.content !== after?.content)
					changed.add((after ?? before)!.key);
			}

			known = current;
			for (const key of changed) listener(key);
		});
	}

	async waitForChange(ms: number): Promise<void> {
		await waitForStateDbChange(this.dbPath, ms);
	}

	private readRow(key: string, pane: StatusPane): ProgramStatusSnapshot | null {
		const row = this.reads.or(null, () =>
			this.openDb()
				.db.query<SnapshotRow, [string, string, string]>(
					`SELECT ${COLUMNS} FROM program_status
					WHERE repo = ? AND key = ? AND generation = ?`,
				)
				.get(this.repo, key, pane.generation),
		);
		return row
			? checkedProgramSnapshot(() => toSnapshot(row), this.repo, key, pane)
			: null;
	}

	/** Every snapshot row of the repo, each as one comparable string. */
	private versions(): Map<string, SnapshotVersion> {
		const rows = this.openDb()
			.db.query<
				SnapshotRow,
				[string]
			>(`SELECT ${COLUMNS} FROM program_status WHERE repo = ?`)
			.all(this.repo);
		return new Map(
			rows.map(row => [
				JSON.stringify([row.key, row.generation]),
				{key: row.key, content: JSON.stringify(row)},
			]),
		);
	}
}

/**
 * A repo's program-status store. Status monitors build theirs without
 * loading the config, so the choice between the two stores is made here for
 * them and for `createStateDaos` alike.
 */
export function createProgramStatusDao(options: {
	sqlite: boolean;
	repo: string;
	stateDir: string;
	dbPath: string;
	openDb: () => StateDb;
}): ProgramStatusDao {
	const json = new JsonProgramStatusDao(
		options.repo,
		programStatusDir(options.repo, options.stateDir),
		options.dbPath,
	);
	return options.sqlite
		? new SqliteProgramStatusDao(options.openDb, json)
		: json;
}

const FLAG_MAX_AGE_MS = 1000;

/**
 * The rows a monitor writes, while experimental.sqliteState is on. A monitor
 * outlives a change of the flag, so it asks `sqliteEnabled` again once what
 * it was last told is a second old.
 */
export function followedSnapshotRows(
	openDb: () => StateDb,
	sqliteEnabled: () => boolean,
	now: () => number = () => performance.now(),
): () => SnapshotRows | undefined {
	const rows = new SqliteSnapshotRows(openDb);
	let enabled = false;
	let readAt = Number.NEGATIVE_INFINITY;
	return () => {
		if (now() - readAt >= FLAG_MAX_AGE_MS) {
			enabled = sqliteEnabled();
			readAt = now();
		}

		return enabled ? rows : undefined;
	};
}
