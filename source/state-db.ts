// The SQLite database behind experimental.sqliteState.
//
// While the flag exists, every store here also keeps its JSON file, so that
// turning the flag off loses nothing. `json_sync` records what each file
// looked like the last time a write went through the database. A file that
// no longer matches was written by a process that bypassed the database (the
// flag was off, or the binary older), and its rows are replaced from it.

import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createLogger} from './logger.ts';
import {ringStateBell} from './state-db-watch.ts';

const log = createLogger('state-db');

export const DEFAULT_STATE_DIR = path.join(homedir(), '.pappardelle');

// The TUI renders on the thread that runs these queries. A write that finds
// another process holding the lock gives up after this long and is retried
// on a timer, so a frame is never held for a whole transaction elsewhere.
const BUSY_TIMEOUT_MS = 20;
const BUSY_RETRY_MS = 25;
const WRITE_DEADLINE_MS = 2000;
// Opening may wait for another process's migration, which runs once.
const OPEN_BUSY_TIMEOUT_MS = 5000;
const CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * Ordered schema changes. `PRAGMA user_version` counts how many have been
 * applied, so entries are only ever appended.
 */
const MIGRATIONS: string[] = [
	`CREATE TABLE json_sync (
		path TEXT PRIMARY KEY,
		ino TEXT NOT NULL,
		size INTEGER NOT NULL,
		mtime_ns TEXT NOT NULL,
		malformed INTEGER NOT NULL DEFAULT 0 CHECK (malformed IN (0, 1))
	) STRICT`,
	`CREATE TABLE spaces (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('starting', 'open', 'closing')),
		owner_pid INTEGER,
		PRIMARY KEY (repo, key)
	) STRICT`,
	`CREATE TABLE claude_status (
		status_key TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		workspace_name TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN (
			'processing', 'running_tool', 'waiting_for_input',
			'waiting_for_approval', 'compacting', 'ended', 'error', 'unknown'
		)),
		last_update INTEGER NOT NULL,
		current_tool TEXT,
		event TEXT,
		cwd TEXT
	) STRICT`,
	`CREATE TABLE space_state (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		profile TEXT,
		pipeline TEXT CHECK (pipeline IN (
			'passing', 'failing', 'progressing_clean', 'progressing_dirty', 'none'
		)),
		unresolved_comment_count INTEGER,
		pr_number INTEGER,
		has_conflict INTEGER CHECK (has_conflict IN (0, 1)),
		recap_custom_title TEXT,
		recap_last_prompt TEXT,
		recap_last_assistant_excerpt TEXT,
		updated_at TEXT,
		PRIMARY KEY (repo, key)
	) STRICT;
	CREATE TABLE space_pr_links (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		host TEXT NOT NULL,
		project TEXT NOT NULL,
		local_branch TEXT NOT NULL,
		remote_branch TEXT NOT NULL,
		url TEXT NOT NULL,
		number INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		PRIMARY KEY (repo, key, host, project, local_branch)
	) STRICT;
	CREATE TABLE issue_meta (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		created_by_pappardelle INTEGER NOT NULL
			CHECK (created_by_pappardelle IN (0, 1)),
		created_at TEXT NOT NULL,
		PRIMARY KEY (repo, key)
	) STRICT`,
	`CREATE TABLE highlight_targets (
		repo TEXT PRIMARY KEY,
		key TEXT NOT NULL,
		focus INTEGER NOT NULL CHECK (focus IN (0, 1)),
		requested_at INTEGER NOT NULL
	) STRICT;
	CREATE TABLE state_colors (
		repo TEXT NOT NULL,
		name TEXT NOT NULL,
		color TEXT NOT NULL,
		PRIMARY KEY (repo, name)
	) STRICT;
	CREATE TABLE watchlist_reservations (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		source TEXT NOT NULL,
		owner_pid INTEGER NOT NULL,
		PRIMARY KEY (repo, key)
	) STRICT`,
	`CREATE TABLE agent_sessions (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		agent_profile TEXT NOT NULL,
		session_id TEXT NOT NULL,
		pid INTEGER,
		started TEXT,
		PRIMARY KEY (repo, key, agent_profile)
	) STRICT;
	CREATE TABLE companion_widths (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		cells INTEGER CHECK (cells > 0),
		percent TEXT CHECK (percent GLOB '[0-9]*%'),
		PRIMARY KEY (repo, key),
		CHECK ((cells IS NULL) <> (percent IS NULL))
	) STRICT;
	CREATE TABLE companion_requests (
		repo TEXT NOT NULL,
		id TEXT NOT NULL,
		space TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('width', 'layout')),
		asked INTEGER NOT NULL DEFAULT 1,
		ack_result TEXT CHECK (ack_result IN (
			'applied', 'stored', 'no-pane', 'deferred', 'failed'
		)),
		ack_columns INTEGER,
		PRIMARY KEY (repo, id),
		CHECK (ack_columns IS NULL OR ack_result IS NOT NULL)
	) STRICT;
	CREATE TABLE schedules (
		repo TEXT NOT NULL,
		id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('at', 'after_limit', 'keep_going')),
		key TEXT NOT NULL,
		at TEXT,
		message TEXT,
		arm INTEGER,
		every_seconds INTEGER,
		nudge TEXT,
		until TEXT,
		idle_checks INTEGER,
		PRIMARY KEY (repo, id),
		CHECK (
			(
				kind = 'keep_going'
				AND every_seconds IS NOT NULL AND nudge IS NOT NULL
				AND idle_checks IS NOT NULL
				AND at IS NULL AND message IS NULL AND arm IS NULL
			) OR (
				kind IN ('at', 'after_limit')
				AND at IS NOT NULL AND message IS NOT NULL AND arm IS NOT NULL
				AND every_seconds IS NULL AND nudge IS NULL AND until IS NULL
				AND idle_checks IS NULL
			)
		)
	) STRICT;
	CREATE TABLE queued_messages (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		text TEXT NOT NULL,
		PRIMARY KEY (repo, key)
	) STRICT;
	CREATE TABLE pr_link_stamp (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		touched_at INTEGER NOT NULL
	) STRICT`,
	`CREATE TABLE program_status (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		generation TEXT NOT NULL,
		pane_id TEXT NOT NULL,
		pane_pid TEXT NOT NULL,
		pane_dead INTEGER NOT NULL CHECK (pane_dead IN (0, 1)),
		pane_piped INTEGER NOT NULL CHECK (pane_piped IN (0, 1)),
		marker TEXT NOT NULL,
		authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
		exited INTEGER NOT NULL CHECK (exited IN (0, 1)),
		updated_at INTEGER NOT NULL,
		records TEXT NOT NULL,
		info TEXT NOT NULL,
		PRIMARY KEY (repo, key, generation)
	) STRICT;
	CREATE TABLE tui_markers (
		repo TEXT PRIMARY KEY,
		pid INTEGER NOT NULL,
		cli_path TEXT NOT NULL,
		sha TEXT NOT NULL,
		pane_id TEXT NOT NULL,
		started_at INTEGER NOT NULL
	) STRICT;
	CREATE TABLE update_check (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		checked_at INTEGER NOT NULL,
		latest_version TEXT NOT NULL
	) STRICT`,
];

let defaultPathForTests: string | undefined;

/**
 * Move the default database for this process only. A test process uses it so
 * that nothing it runs reaches the developer's own database, while the CLIs
 * it starts under a throwaway HOME still find theirs there.
 */
export function setDefaultStateDbPathForTests(
	dbPath: string | undefined,
): void {
	defaultPathForTests = dbPath;
}

/**
 * Where the database lives. An explicit state directory (a test's temp
 * directory) always holds its own; PAPPARDELLE_STATE_DB moves the default one.
 */
export function stateDbPath(
	stateDir?: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (stateDir) return path.join(stateDir, 'state.db');
	return (
		env['PAPPARDELLE_STATE_DB'] ??
		defaultPathForTests ??
		path.join(DEFAULT_STATE_DIR, 'state.db')
	);
}

export function isBusyError(error: unknown): boolean {
	const code = (error as {code?: unknown} | null)?.code;
	return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/** Run `attempt` again on a timer while another process holds the write lock. */
export async function retryBusy<T>(
	attempt: () => T | Promise<T>,
	deadlineMs = WRITE_DEADLINE_MS,
): Promise<T> {
	const deadline = performance.now() + deadlineMs;
	for (;;) {
		try {
			return await attempt();
		} catch (error) {
			if (!isBusyError(error) || performance.now() >= deadline) throw error;
			await delay(BUSY_RETRY_MS);
		}
	}
}

type FileSignature = {ino: string; size: number; mtimeNs: string};

function signatureOf(stat: fs.BigIntStats): FileSignature {
	return {
		ino: String(stat.ino),
		size: Number(stat.size),
		mtimeNs: String(stat.mtimeNs),
	};
}

function statSignature(file: string): FileSignature | null {
	try {
		return signatureOf(fs.statSync(file, {bigint: true}));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

/**
 * Replace `file` by rename so a reader never sees half of it. The signature
 * is taken before the rename, which keeps inode, size and mtime: read
 * afterwards it could be another writer's file.
 */
export function writeFileAtomic(file: string, content: string): FileSignature {
	const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
	try {
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(temporary, content);
		const signature = signatureOf(fs.statSync(temporary, {bigint: true}));
		fs.renameSync(temporary, file);
		return signature;
	} finally {
		fs.rmSync(temporary, {force: true});
	}
}

/** A JSON file that mirrors some rows. */
export type JsonMirror = {
	file: string;
	/**
	 * Replace the rows this file holds from its content, or from `null` when
	 * the file is gone. Throws when the content is not what the store writes.
	 */
	importRows(content: string | null): void;
};

export type SyncResult = 'in-sync' | 'imported' | 'malformed' | 'busy';

/** What a write transaction may do to the mirrored files. */
export type WriteTx = {
	/** Bring the file's rows up to date before changing them. */
	sync(mirror: JsonMirror): SyncResult;
	/** Write the file from the rows just changed, or remove it with `null`. */
	mirror(file: string, content: string | null): void;
};

type SyncRow = {ino: string; size: number; mtime_ns: string; malformed: number};

export class StateDb {
	private readonly reportedMalformed = new Set<string>();

	constructor(
		readonly db: Database,
		readonly path: string,
	) {}

	/**
	 * Make `mirror`'s rows match its file if a writer that bypassed the
	 * database changed it. Reads call this before querying.
	 */
	sync(mirror: JsonMirror): SyncResult {
		const known = this.known(mirror.file);
		if (known) return known;
		try {
			return this.db
				.transaction(() => this.syncInTransaction(mirror))
				.immediate();
		} catch (error) {
			// Another process is writing. Its rows are served now and the file
			// is looked at again on the next read.
			if (isBusyError(error)) return 'busy';
			throw error;
		}
	}

	/**
	 * One write transaction, attempted once: throws SQLITE_BUSY when another
	 * process holds the write lock. Callers that already hold a file lock use
	 * this and retry around both.
	 */
	tryWrite<T>(body: (tx: WriteTx) => T): T {
		const tx: WriteTx = {
			sync: mirror => this.syncInTransaction(mirror),
			mirror: (file, content) => {
				if (content === null) {
					fs.rmSync(file, {force: true});
					this.db.query('DELETE FROM json_sync WHERE path = ?').run(file);
				} else {
					this.record(file, writeFileAtomic(file, content), false);
				}
			},
		};
		return this.notifying(() =>
			this.db.transaction(() => body(tx)).immediate(),
		);
	}

	/** A write transaction that waits out other writers without blocking. */
	async write<T>(body: (tx: WriteTx) => T): Promise<T> {
		return retryBusy(() => this.tryWrite(body));
	}

	/**
	 * Rows changed without a mirrored file, attempted once: throws SQLITE_BUSY
	 * when another process holds the write lock.
	 */
	tryWriteRows<T>(body: () => T): T {
		return this.notifying(() => this.db.transaction(body).immediate());
	}

	/** Rows changed without a mirrored file, for stores that keep none. */
	async writeRows<T>(body: () => T): Promise<T> {
		return retryBusy(() => this.tryWriteRows(body));
	}

	/** Ring the bell for watchers in other processes when rows changed. */
	private notifying<T>(run: () => T): T {
		const before = this.totalChanges();
		const result = run();
		if (this.totalChanges() !== before) ringStateBell(this.path);
		return result;
	}

	private totalChanges(): number {
		return this.db
			.query<{changes: number}, []>('SELECT total_changes() AS changes')
			.get()!.changes;
	}

	/** The recorded state of `file` when it still matches what is on disk. */
	private known(file: string): 'in-sync' | 'malformed' | null {
		const row = this.db
			.query<
				SyncRow,
				[string]
			>('SELECT ino, size, mtime_ns, malformed FROM json_sync WHERE path = ?')
			.get(file);
		const signature = statSignature(file);
		if (!row && !signature) return 'in-sync';
		if (
			!row ||
			!signature ||
			row.ino !== signature.ino ||
			row.size !== signature.size ||
			row.mtime_ns !== signature.mtimeNs
		)
			return null;
		return row.malformed ? 'malformed' : 'in-sync';
	}

	private syncInTransaction(mirror: JsonMirror): SyncResult {
		// Checked again under the write lock: the writer that changed the file
		// may have committed its rows since the first look.
		const known = this.known(mirror.file);
		if (known) return known;
		const read = readWithSignature(mirror.file);
		try {
			// Nested, so an import that fails halfway leaves no rows behind.
			this.db.transaction(() => {
				mirror.importRows(read?.content ?? null);
			})();
		} catch (error) {
			if (read) this.record(mirror.file, read.signature, true);
			if (!this.reportedMalformed.has(mirror.file)) {
				this.reportedMalformed.add(mirror.file);
				log.warn(
					`Kept the stored rows: ${mirror.file} is not readable as state`,
					error instanceof Error ? error : undefined,
				);
			}
			return 'malformed';
		}

		if (read) this.record(mirror.file, read.signature, false);
		else this.db.query('DELETE FROM json_sync WHERE path = ?').run(mirror.file);
		// r29.6 deletes the JSON code once nothing writes around the database,
		// so each of these is a writer it still has to account for.
		log.info(`Imported ${mirror.file}, written outside the state database`);
		return 'imported';
	}

	private record(
		file: string,
		signature: FileSignature,
		malformed: boolean,
	): void {
		this.db
			.query(
				`INSERT INTO json_sync (path, ino, size, mtime_ns, malformed)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (path) DO UPDATE SET ino = excluded.ino,
					size = excluded.size, mtime_ns = excluded.mtime_ns,
					malformed = excluded.malformed`,
			)
			.run(
				file,
				signature.ino,
				signature.size,
				signature.mtimeNs,
				malformed ? 1 : 0,
			);
	}
}

/**
 * One store's reads while the database cannot be opened or read. The rail
 * reads while it renders, where a throw replaces the whole view, so a read
 * answers what it answers for a record that is not there, and the failure is
 * logged once: the rail reads every space again on each refresh.
 */
export class GuardedReads {
	private reported = false;

	constructor(
		private readonly log: Pick<ReturnType<typeof createLogger>, 'warn'>,
		private readonly what: string,
	) {}

	/** What `read` returns, or `unknown` when it throws. */
	or<T, U>(unknown: U, read: () => T): T | U {
		try {
			return read();
		} catch (error) {
			if (!this.reported) {
				this.reported = true;
				this.log.warn(
					`Could not read ${this.what} from the state database`,
					error instanceof Error ? error : undefined,
				);
			}

			return unknown;
		}
	}
}

/** The file's content with the signature of the bytes that were read. */
function readWithSignature(
	file: string,
): {content: string; signature: FileSignature} | null {
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, 'r');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}

	try {
		const signature = signatureOf(fs.fstatSync(descriptor, {bigint: true}));
		return {content: fs.readFileSync(descriptor, 'utf8'), signature};
	} finally {
		fs.closeSync(descriptor);
	}
}

const connections = new Map<string, StateDb>();

/** Apply any schema changes this build has that the file does not. */
function migrate(db: Database): void {
	const version = () =>
		db.query<{user_version: number}, []>('PRAGMA user_version').get()!
			.user_version;
	if (version() >= MIGRATIONS.length) return;
	db.transaction(() => {
		// Another process may have migrated while this one waited for the lock.
		for (let index = version(); index < MIGRATIONS.length; index++) {
			db.run(MIGRATIONS[index]!);
		}

		db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
	}).immediate();
}

/**
 * Put a new database into write-ahead mode. While another process is doing
 * the same to the same new file, SQLite refuses at once instead of waiting
 * out busy_timeout, so this asks again until that process is done.
 */
function enableWal(db: Database): void {
	const deadline = performance.now() + OPEN_BUSY_TIMEOUT_MS;
	for (;;) {
		const mode = db
			.query<{journal_mode: string}, []>('PRAGMA journal_mode')
			.get();
		if (mode?.journal_mode === 'wal') return;
		try {
			db.run('PRAGMA journal_mode = WAL');
			return;
		} catch (error) {
			if (!isBusyError(error) || performance.now() >= deadline) throw error;
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				BUSY_RETRY_MS,
			);
		}
	}
}

/** The process's connection to the database at `dbPath`, opened on first use. */
export function openStateDb(dbPath: string): StateDb {
	const existing = connections.get(dbPath);
	if (existing) return existing;
	fs.mkdirSync(path.dirname(dbPath), {recursive: true});
	const db = new Database(dbPath, {create: true, strict: true});
	try {
		db.run(`PRAGMA busy_timeout = ${OPEN_BUSY_TIMEOUT_MS}`);
		enableWal(db);
		db.run('PRAGMA synchronous = NORMAL');
		db.run('PRAGMA foreign_keys = ON');
		migrate(db);
		db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	} catch (error) {
		// Every read tries again while the file cannot be used, and each
		// attempt would otherwise leave a file handle open.
		db.close();
		throw error;
	}

	const state = new StateDb(db, dbPath);
	connections.set(dbPath, state);
	return state;
}

const checkpointTimers = new WeakMap<StateDb, ReturnType<typeof setInterval>>();

/** Move what the write-ahead log holds into the database file, as far as readers allow. */
export function checkpoint(state: StateDb): void {
	try {
		state.db.run('PRAGMA wal_checkpoint(PASSIVE)');
	} catch (error) {
		log.debug(`Could not checkpoint the state database: ${String(error)}`);
	}
}

/**
 * Stop this connection checkpointing inside its commits, and checkpoint on a
 * timer instead. For the TUI, which renders on the thread that commits.
 *
 * While other processes write without a pause (status monitors under load),
 * the log stays past the size that triggers a checkpoint, so every commit on
 * a connection with the default setting attempts one. A checkpoint is two
 * fsyncs, 4 to 7 ms measured. Hooks, CLI verbs and status monitors keep the
 * default and do most of the checkpointing.
 */
export function checkpointOutsideWrites(state: StateDb): void {
	if (checkpointTimers.has(state)) return;
	state.db.run('PRAGMA wal_autocheckpoint = 0');
	const timer = setInterval(() => {
		checkpoint(state);
	}, CHECKPOINT_INTERVAL_MS);
	timer.unref();
	checkpointTimers.set(state, timer);
}

/** Close and forget a connection, so a test can remove its directory. */
export function closeStateDb(dbPath: string): void {
	const state = connections.get(dbPath);
	if (!state) return;
	clearInterval(checkpointTimers.get(state));
	checkpointTimers.delete(state);
	state.db.close();
	connections.delete(dbPath);
}
