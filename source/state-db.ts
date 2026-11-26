// The SQLite database that holds Pappardelle's state.

import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createLogger} from './logger.ts';
import {ringStateBell} from './state-db-watch.ts';
import {readStateEnv} from './state-env.ts';

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
	) STRICT;
	CREATE TABLE space_identities (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		worktree_path TEXT NOT NULL,
		tmux_socket TEXT NOT NULL,
		agent_session TEXT NOT NULL,
		companion_session TEXT NOT NULL,
		PRIMARY KEY (repo, key)
	) STRICT;
	CREATE UNIQUE INDEX space_identities_agent
		ON space_identities (agent_session, tmux_socket)`,
	`CREATE TABLE space_state (
		repo TEXT NOT NULL,
		key TEXT NOT NULL,
		profile TEXT,
		issue_title TEXT,
		pipeline TEXT CHECK (pipeline IN (
			'passing', 'failing', 'progressing_clean', 'progressing_dirty', 'none'
		)),
		unresolved_comment_count INTEGER,
		pr_number INTEGER,
		has_conflict INTEGER CHECK (has_conflict IN (0, 1)),
		recap_custom_title TEXT,
		recap_last_prompt TEXT,
		recap_last_assistant_excerpt TEXT,
		agent_profile TEXT,
		agent_is_claude INTEGER CHECK (agent_is_claude IN (0, 1)),
		updated_at TEXT,
		PRIMARY KEY (repo, key),
		CHECK ((agent_profile IS NULL) = (agent_is_claude IS NULL))
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
	`CREATE TABLE tui_markers (
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
	`CREATE TABLE holds (
		repo TEXT NOT NULL,
		id TEXT NOT NULL,
		key TEXT NOT NULL,
		tool TEXT NOT NULL,
		command TEXT NOT NULL,
		file_path TEXT,
		cwd TEXT,
		approvable INTEGER NOT NULL CHECK (approvable IN (0, 1)),
		reason TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('open', 'approved', 'dismissed', 'used')),
		created_at TEXT NOT NULL,
		resolved_at TEXT,
		PRIMARY KEY (repo, id)
	) STRICT`,
	`ALTER TABLE schedules ADD COLUMN defer_reason TEXT;
	ALTER TABLE schedules ADD COLUMN defer_count INTEGER`,
	// Present once the JSON files from before the database held all the state
	// have been imported. json_sync is emptied then, not dropped, so that a
	// build from before reads its files as gone, not as changed.
	`CREATE TABLE json_import (imported_at INTEGER NOT NULL) STRICT`,
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
		readStateEnv(env).dbPath ??
		defaultPathForTests ??
		path.join(DEFAULT_STATE_DIR, 'state.db')
	);
}

// The number is the protocol's. A daemon that an update left running keeps
// its old file name, so a newer client never speaks to it.
const STATUS_SOCKET_NAME = 'status-1.sock';

/**
 * Where the status daemon listens: beside the database, so whatever moves the
 * database (a test's temp directory, PAPPARDELLE_STATE_DB) moves the daemon
 * with it. PAPPARDELLE_STATUS_SOCKET names another place, except that an
 * explicit state directory always holds its own socket, as it does its own
 * database.
 */
export function statusSocketPath(
	stateDir?: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (stateDir) return path.join(stateDir, STATUS_SOCKET_NAME);
	return (
		readStateEnv(env).statusSocket ??
		path.join(path.dirname(stateDbPath(undefined, env)), STATUS_SOCKET_NAME)
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

/** A lookup in a store that could not be read, which must never look empty. */
export type Unreadable = {kind: 'unreadable'; error: unknown};

/**
 * A JSON file from before the database held all the state, with how to turn
 * it into rows. Only the one-time import reads these.
 */
export type JsonMirror = {
	file: string;
	/**
	 * Replace the rows this file holds from its content, or from `null` when
	 * the file is gone. Throws when the content is not what the store wrote.
	 */
	importRows(content: string | null): void;
	/**
	 * A file whose rows must never look empty, such as the registry: the
	 * reaper ends the sessions of every space it does not list. One that
	 * can't be imported stops the import, and the database stays unreadable
	 * until the file is fixed or removed.
	 */
	required?: boolean;
};

type SyncRow = {
	ino: string;
	size: number;
	mtime_ns: string;
	malformed: 0 | 1;
};

export class StateDb {
	constructor(
		readonly db: Database,
		readonly path: string,
	) {}

	/** Whether the JSON files have yet to be imported. */
	hasJsonToImport(): boolean {
		return (
			this.db
				.query<{found: number}, []>('SELECT 1 AS found FROM json_import')
				.get() === null
		);
	}

	/**
	 * Import every mirror's file into its rows, once, and return the files to
	 * delete now that their rows hold them. Another process that opens the
	 * database meanwhile waits for the import, and finds it done.
	 *
	 * `json_sync` records what each file looked like when a write last went
	 * through the database, so a file that still matches is already in its
	 * rows. One that doesn't was written by a process without the database.
	 */
	importJson(mirrors: () => JsonMirror[]): string[] {
		this.db.run(`PRAGMA busy_timeout = ${OPEN_BUSY_TIMEOUT_MS}`);
		try {
			return this.notifying(() =>
				this.db
					.transaction(() => {
						if (!this.hasJsonToImport()) return [];
						const imported = mirrors().flatMap(mirror =>
							this.importMirror(mirror) ? [mirror.file] : [],
						);
						this.db.run('DELETE FROM json_sync');
						this.db
							.query('INSERT INTO json_import (imported_at) VALUES (?)')
							.run(Date.now());
						return imported;
					})
					.immediate(),
			);
		} finally {
			this.db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		}
	}

	/**
	 * The keys of the `<key><suffix>` files in `dir`, for the one-time import:
	 * those on disk, and those a write through the database recorded whose
	 * file a process without the database has since removed.
	 */
	jsonKeysIn(dir: string, suffix: string, except: string[] = []): string[] {
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir);
		} catch {}

		const recorded = this.db
			.query<{path: string}, [string]>(
				"SELECT path FROM json_sync WHERE path LIKE ? ESCAPE '\\'",
			)
			.all(`${dir.replaceAll(/[\\%_]/g, '\\$&')}/%`)
			.map(row => path.relative(dir, row.path))
			.filter(name => !name.includes('/'));
		const keys = new Set<string>();
		for (const name of [...names, ...recorded]) {
			if (!name.endsWith(suffix) || name.includes('.tmp.')) continue;
			if (except.some(other => name.endsWith(other))) continue;
			keys.add(name.slice(0, -suffix.length));
		}

		return [...keys].sort();
	}

	/** One write transaction, attempted once: throws SQLITE_BUSY when another process holds the write lock. */
	tryWrite<T>(body: () => T): T {
		return this.notifying(() => this.db.transaction(body).immediate());
	}

	/** A write transaction that waits out other writers without blocking. */
	async write<T>(body: () => T): Promise<T> {
		return retryBusy(() => this.tryWrite(body));
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

	/**
	 * Bring a mirror's rows up to date with its file. True when the file can
	 * go: its rows hold it, or it is gone already. A file that can't be read
	 * as state is kept, and its rows stay as they were.
	 */
	private importMirror(mirror: JsonMirror): boolean {
		let read: ReturnType<typeof readWithSignature>;
		try {
			read = readWithSignature(mirror.file);
		} catch (error) {
			return this.notImported(mirror, error);
		}

		const row = this.db
			.query<
				SyncRow,
				[string]
			>('SELECT ino, size, mtime_ns, malformed FROM json_sync WHERE path = ?')
			.get(mirror.file);
		// A file a write recorded as malformed never had its rows replaced, so
		// matching it says nothing about them.
		const inSync =
			read === null
				? row === null
				: row !== null &&
					row.malformed === 0 &&
					row.ino === read.signature.ino &&
					row.size === read.signature.size &&
					row.mtime_ns === read.signature.mtimeNs;
		if (inSync) return read !== null;
		try {
			// Nested, so an import that fails halfway leaves no rows behind.
			this.db.transaction(() => {
				mirror.importRows(read?.content ?? null);
			})();
		} catch (error) {
			return this.notImported(mirror, error);
		}

		if (read) log.info(`Imported ${mirror.file} into the state database`);
		return read !== null;
	}

	private notImported(mirror: JsonMirror, error: unknown): false {
		const cause = error instanceof Error ? error.message : String(error);
		if (mirror.required)
			throw new Error(
				`Could not import ${mirror.file} (${cause}). Fix or remove it, and Pappardelle imports the rest of its state`,
			);
		log.warn(
			`Kept ${mirror.file}: it is not readable as state, so its rows stay as they were`,
			error instanceof Error ? error : undefined,
		);
		return false;
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

/**
 * Every repo with Pappardelle state, by the name its sessions carry: those
 * the database at `dbPath` holds, and those with a directory under
 * `<stateDir>/repos` from before it held them. None when neither can be read.
 */
export function listKnownRepos(
	dbPath = stateDbPath(),
	stateDir = DEFAULT_STATE_DIR,
): string[] {
	const repos = new Set<string>();
	try {
		for (const entry of fs.readdirSync(path.join(stateDir, 'repos'), {
			withFileTypes: true,
		}))
			if (entry.isDirectory()) repos.add(entry.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			log.warn(
				`Could not list the repos in ${stateDir}`,
				error instanceof Error ? error : undefined,
			);
	}

	try {
		for (const {repo} of openStateDb(dbPath)
			.db.query<{repo: string}, []>(
				`SELECT repo FROM spaces UNION SELECT repo FROM space_identities
				UNION SELECT repo FROM tui_markers`,
			)
			.all())
			repos.add(repo);
	} catch (error) {
		log.warn(
			'Could not read the repos the state database knows',
			error instanceof Error ? error : undefined,
		);
	}

	return [...repos].sort();
}

const checkpointTimers = new WeakMap<StateDb, ReturnType<typeof setInterval>>();

/** Move what the write-ahead log holds into the database file, as far as readers allow. */
export function checkpoint(state: StateDb): void {
	try {
		state.db.run('PRAGMA wal_checkpoint(PASSIVE)');
	} catch (error) {
		log.warn(
			'Could not checkpoint the state database',
			error instanceof Error ? error : undefined,
		);
	}
}

/**
 * Stop this connection checkpointing inside its commits, and checkpoint on a
 * timer instead. For the TUI, which renders on the thread that commits.
 *
 * While other processes write without a pause, the log stays past the size
 * that triggers a checkpoint, so every commit on a connection with the
 * default setting attempts one. A checkpoint is two fsyncs, 4 to 7 ms
 * measured. Hooks and CLI verbs keep the default and do most of the
 * checkpointing.
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
