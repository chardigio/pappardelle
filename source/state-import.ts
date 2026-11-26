// The one-time import of the JSON files Pappardelle kept its state in before
// the database held all of it. This is the only module that knows those files.

import fs from 'node:fs';
import path from 'node:path';
import {SqliteAgentSessionsDao} from './agent-sessions-sqlite.ts';
import {SqliteCompanionWidthDao} from './companion-width-sqlite.ts';
import {HOLD_STATES, type Hold, type HoldState} from './holds.ts';
import {SqliteHoldDao} from './holds-sqlite.ts';
import type {IssueMeta} from './issue-meta.ts';
import {SqliteIssueMetaDao} from './issue-meta-sqlite.ts';
import {isPaneWidth, type PaneWidth} from './layout-sizing.ts';
import {createLogger} from './logger.ts';
import {SqliteStateColorDao} from './providers/state-color-cache-sqlite.ts';
import {PIPELINE_STATUSES, type PipelineStatus} from './providers/types.ts';
import type {Job, SendOutcome} from './schedule.ts';
import {SqliteScheduleDao} from './schedule-sqlite.ts';
import type {IdentityDefaults} from './space-identity.ts';
import {SqliteSpaceIdentityDao} from './space-identity-sqlite.ts';
import type {WatchlistReservation} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import type {AgentSession} from './agent-sessions.ts';
import type {
	LaunchedAgentProfile,
	SpacePrLink,
	SpaceRecap,
	SpaceState,
} from './space-state.ts';
import {SqliteSpaceStateDao} from './space-state-sqlite.ts';
import {openStateDb, type StateDb} from './state-db.ts';
import type {TuiMarker} from './tui-marker.ts';
import {SqliteTuiMarkerDao} from './tui-marker-sqlite.ts';
import type {CacheEntry} from './update-check.ts';
import {SqliteUpdateCheckDao} from './update-check-sqlite.ts';

const log = createLogger('state-import');

/** A JSON file from before the database held all the state, with how to turn it into rows. */
type LegacyFile = {
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

// A connection closed and opened again is a new StateDb, which checks again.
const imported = new WeakSet<StateDb>();

/** Open the database at `dbPath`, importing the JSON state in `stateDir` the first time. */
export function openImportedStateDb(
	dbPath: string,
	stateDir: string,
	defaults: Omit<IdentityDefaults, 'repo'>,
): StateDb {
	const state = openStateDb(dbPath);
	if (!imported.has(state)) {
		importJsonState(state, stateDir, defaults);
		imported.add(state);
	}

	return state;
}

/**
 * Import the JSON files every repo under `stateDir` kept, once, and delete
 * them. Another process that opens the database meanwhile waits for the
 * import, and finds it done. A database moved away from `stateDir` is not
 * the one those files belong to, so it imports none of them.
 */
function importJsonState(
	state: StateDb,
	stateDir: string,
	defaults: Omit<IdentityDefaults, 'repo'>,
): void {
	if (!hasJsonToImport(state)) return;
	const ownsFiles =
		path.resolve(state.path) === path.join(path.resolve(stateDir), 'state.db');
	const files = state.writeOnOpen(() => {
		if (!hasJsonToImport(state)) return [];
		const done = ownsFiles ? importFiles(state, stateDir, defaults) : [];
		state.db.run('DELETE FROM json_sync');
		state.db
			.query('INSERT INTO json_import (imported_at) VALUES (?)')
			.run(Date.now());
		return done;
	});
	if (!ownsFiles) return;
	recordFlagForOlderMonitors(state.path, stateDir);
	for (const file of [...files, ...obsoleteFiles(stateDir)]) {
		try {
			fs.rmSync(file, {force: true, recursive: true});
		} catch (error) {
			log.warn(
				`Could not delete ${file} after importing it`,
				error instanceof Error ? error : undefined,
			);
		}
	}
}

function hasJsonToImport(state: StateDb): boolean {
	return (
		state.db
			.query<{found: number}, []>('SELECT 1 AS found FROM json_import')
			.get() === null
	);
}

/** Import every file into its rows, and return the files to delete. */
function importFiles(
	state: StateDb,
	stateDir: string,
	defaults: Omit<IdentityDefaults, 'repo'>,
): string[] {
	const done: string[] = [];
	const importAll = (files: LegacyFile[]) => {
		for (const file of files) if (importFile(state, file)) done.push(file.file);
	};

	importAll([updateCheckFile(state, stateDir)]);
	for (const repo of reposToImport(state, stateDir)) {
		const repoDir = path.join(stateDir, 'repos', repo);
		importAll(repoFiles(state, repoDir, repo, defaults));
		// A request left in the file was meant for a TUI that has since
		// stopped, so it is dropped rather than shown on the next start.
		done.push(path.join(repoDir, 'highlight-target'));
	}

	return done;
}

/** What no store imports: hook status and its pending-files scratch, and the pr-link stamp's file. */
function obsoleteFiles(stateDir: string): string[] {
	return ['claude-status', 'pr-link.stamp'].map(name =>
		path.join(stateDir, name),
	);
}

function updateCheckFile(state: StateDb, stateDir: string): LegacyFile {
	const updateCheck = new SqliteUpdateCheckDao(() => state);
	return {
		file: path.join(stateDir, 'update-check.json'),
		importRows(content) {
			if (content === null) updateCheck.delete();
			else updateCheck.put(parseCachedCheck(content));
		},
	};
}

/** One repo's files, in the order they are imported. */
function repoFiles(
	state: StateDb,
	repoDir: string,
	repo: string,
	defaults: Omit<IdentityDefaults, 'repo'>,
): LegacyFile[] {
	const openDb = () => state;
	const clock = () => new Date();
	const identities = new SqliteSpaceIdentityDao(openDb, {...defaults, repo});
	const registry = new SqliteSpaceRegistryDao(openDb, repo, identities);
	const spaceState = new SqliteSpaceStateDao(openDb, repo, clock);
	const agentSessions = new SqliteAgentSessionsDao(openDb, repo);
	const issueMeta = new SqliteIssueMetaDao(openDb, repo, clock);
	const stateColors = new SqliteStateColorDao(openDb, repo);
	const companionWidths = new SqliteCompanionWidthDao(openDb, repo);
	const schedules = new SqliteScheduleDao(openDb, repo);
	const holds = new SqliteHoldDao(openDb, repo);
	const tuiMarker = new SqliteTuiMarkerDao(openDb, repo);
	const spaceStateDir = path.join(repoDir, 'space-state');
	return [
		{
			file: path.join(repoDir, 'open-spaces.json'),
			required: true,
			importRows(content) {
				// A registry file that is gone says nothing about the rows.
				if (content === null) return;
				const keys = parseRegistry(content);
				registry.replaceOpen(keys);
				identities.fillMissing(keys);
			},
		},
		{
			file: path.join(repoDir, 'watchlist-spawns.json'),
			importRows(content) {
				if (content !== null)
					registry.replaceReservations(parseWatchlistReservations(content));
			},
		},
		...keyed(
			state,
			spaceStateDir,
			'.json',
			{
				put: (key, content) =>
					spaceState.replace(key, parseSpaceState(content)),
				remove: key => spaceState.replace(key, null),
			},
			['.agent-sessions.json'],
		),
		...keyed(state, spaceStateDir, '.agent-sessions.json', {
			put: (key, content) =>
				agentSessions.replace(key, parseAgentSessions(content)),
			remove: key => agentSessions.replace(key, new Map()),
		}),
		...keyed(state, path.join(repoDir, 'issue-meta'), '.json', {
			put: (key, content) => issueMeta.put(key, parseIssueMeta(content)),
			remove: key => issueMeta.deleteRow(key),
		}),
		{
			file: path.join(repoDir, 'state-colors.json'),
			importRows(content) {
				if (content !== null) stateColors.replace(parseStateColors(content));
			},
		},
		{
			file: path.join(repoDir, 'companion-widths.json'),
			importRows(content) {
				if (content !== null)
					companionWidths.replace(parseCompanionWidths(content));
			},
		},
		// A finished or cancelled job's file is removed, so its row goes with it.
		...keyed(state, path.join(repoDir, 'schedules'), '.json', {
			put: (_id, content) => schedules.put(parseJob(content)),
			remove: id => schedules.deleteRow(id),
		}),
		// Named by the space key, URI-encoded. The file is removed once its
		// message is sent.
		...keyed(state, path.join(repoDir, 'queued'), '.txt', {
			put: (name, content) =>
				schedules.putQueued(decodeURIComponent(name), content),
			remove: name => schedules.deleteQueued(decodeURIComponent(name)),
		}),
		...keyed(state, path.join(repoDir, 'holds'), '.json', {
			put: (_id, content) => holds.put(parseHold(content)),
			remove: id => holds.deleteRow(id),
		}),
		{
			file: path.join(repoDir, 'tui.json'),
			importRows(content) {
				if (content === null) tuiMarker.delete();
				else tuiMarker.put(parseTuiMarker(content));
			},
		},
	];
}

/** The `<key><suffix>` files in `dir`, one per key. */
function keyed(
	state: StateDb,
	dir: string,
	suffix: string,
	rows: {
		put(key: string, content: string): void;
		remove(key: string): void;
	},
	except: string[] = [],
): LegacyFile[] {
	return jsonKeysIn(state, dir, suffix, except).map(key => ({
		file: path.join(dir, `${key}${suffix}`),
		importRows(content) {
			if (content === null) rows.remove(key);
			else rows.put(key, content);
		},
	}));
}

/**
 * The keys of the `<key><suffix>` files in `dir`: those on disk, and those a
 * write through the database recorded whose file a process without the
 * database has since removed.
 */
function jsonKeysIn(
	state: StateDb,
	dir: string,
	suffix: string,
	except: string[],
): string[] {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir);
	} catch {}

	const recorded = state.db
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

/**
 * The repos with a directory under `<stateDir>/repos`, and those whose files
 * a write through the database recorded, even if a process without the
 * database has since removed them.
 */
function reposToImport(state: StateDb, stateDir: string): string[] {
	const reposDir = path.join(stateDir, 'repos');
	const repos = new Set<string>();
	try {
		for (const entry of fs.readdirSync(reposDir, {withFileTypes: true}))
			if (entry.isDirectory()) repos.add(entry.name);
	} catch {}

	for (const {path: file} of state.db
		.query<{path: string}, []>('SELECT path FROM json_sync')
		.all()) {
		const [repo, ...rest] = path.relative(reposDir, file).split(path.sep);
		if (repo && repo !== '..' && rest.length > 0) repos.add(repo);
	}

	return [...repos].sort();
}

type FileSignature = {ino: string; size: number; mtimeNs: string};

type SyncRow = {
	ino: string;
	size: number;
	mtime_ns: string;
	malformed: 0 | 1;
};

/**
 * Bring a file's rows up to date with it. True when the file can go: its
 * rows hold it, or it is gone already. A file that can't be read as state is
 * kept, and its rows stay as they were.
 *
 * `json_sync` records what each file looked like when a write last went
 * through the database, so a file that still matches is already in its rows.
 * One that doesn't was written by a process without the database.
 */
function importFile(state: StateDb, legacy: LegacyFile): boolean {
	let read: ReturnType<typeof readWithSignature>;
	try {
		read = readWithSignature(legacy.file);
	} catch (error) {
		return notImported(legacy, error);
	}

	const row = state.db
		.query<
			SyncRow,
			[string]
		>('SELECT ino, size, mtime_ns, malformed FROM json_sync WHERE path = ?')
		.get(legacy.file);
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
		state.db.transaction(() => {
			legacy.importRows(read?.content ?? null);
		})();
	} catch (error) {
		return notImported(legacy, error);
	}

	if (read) log.info(`Imported ${legacy.file} into the state database`);
	return read !== null;
}

function notImported(legacy: LegacyFile, error: unknown): false {
	const cause = error instanceof Error ? error.message : String(error);
	if (legacy.required)
		throw new Error(
			`Could not import ${legacy.file} (${cause}). Fix or remove it, and Pappardelle imports the rest of its state`,
		);
	log.warn(
		`Kept ${legacy.file}: it is not readable as state, so its rows stay as they were`,
		error instanceof Error ? error : undefined,
	);
	return false;
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
		const stat = fs.fstatSync(descriptor, {bigint: true});
		return {
			content: fs.readFileSync(descriptor, 'utf8'),
			signature: {
				ino: String(stat.ino),
				size: Number(stat.size),
				mtimeNs: String(stat.mtimeNs),
			},
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

/**
 * An agent pane's status monitor lives as long as the pane, and one started
 * by an older build sends its snapshots to the daemon only while this file
 * says the flag is on. Without it, such a pane would show no program status
 * until its agent relaunches.
 */
function recordFlagForOlderMonitors(dbPath: string, stateDir: string): void {
	try {
		fs.writeFileSync(
			path.join(stateDir, 'state-flag.json'),
			`${JSON.stringify({sqliteState: true, db: dbPath})}\n`,
		);
	} catch (error) {
		log.warn(
			'Could not tell status monitors from an older build to use the status daemon',
			error instanceof Error ? error : undefined,
		);
	}
}

// ---------------------------------------------------------------------------
// What each store's files held. Each parser throws when the content is not
// what the store wrote.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';

const isOptionalString = (value: unknown): value is string | null =>
	value === null || isString(value);

const stringOrNothing = (value: unknown): string | undefined =>
	isString(value) ? value : undefined;

const integerOrNothing = (value: unknown): number | undefined =>
	Number.isInteger(value) ? (value as number) : undefined;

/** The keys in a registry file. */
function parseRegistry(content: string): string[] {
	const parsed: unknown = JSON.parse(content);
	if (!Array.isArray(parsed)) throw new Error('Invalid workspace registry');
	return [...new Set(parsed.filter(key => isString(key)))];
}

function parseWatchlistReservations(
	content: string,
): Map<string, WatchlistReservation> {
	const parsed: unknown = JSON.parse(content);
	if (!isRecord(parsed)) throw new Error('Invalid watchlist reservations');
	const reservations = new Map<string, WatchlistReservation>();
	for (const [key, value] of Object.entries(parsed)) {
		const entry = value as Partial<WatchlistReservation> | null;
		if (isString(entry?.source) && typeof entry.ownerPid === 'number') {
			reservations.set(key, {source: entry.source, ownerPid: entry.ownerPid});
		}
	}

	return reservations;
}

function parseRecap(value: Record<string, unknown>): SpaceRecap {
	const customTitle = stringOrNothing(value['customTitle']);
	const lastPrompt = stringOrNothing(value['lastPrompt']);
	const lastAssistantExcerpt = stringOrNothing(value['lastAssistantExcerpt']);
	return {
		...(customTitle === undefined ? {} : {customTitle}),
		...(lastPrompt === undefined ? {} : {lastPrompt}),
		...(lastAssistantExcerpt === undefined ? {} : {lastAssistantExcerpt}),
	};
}

function parseAgentProfile(value: unknown): LaunchedAgentProfile | undefined {
	if (!isRecord(value)) return undefined;
	const {name, isClaude} = value;
	return isString(name) && typeof isClaude === 'boolean'
		? {name, isClaude}
		: undefined;
}

function parsePrLink(value: unknown): SpacePrLink | undefined {
	if (!isRecord(value)) return undefined;
	const {host, project, localBranch, remoteBranch, url, number} = value;
	if (
		!isString(host) ||
		!isString(project) ||
		!isString(localBranch) ||
		!isString(remoteBranch) ||
		!isString(url) ||
		!Number.isInteger(number)
	)
		return undefined;
	return {
		host,
		project,
		localBranch,
		remoteBranch,
		url,
		number: number as number,
	};
}

/**
 * The fields of a space-state file. The file had several writers, other
 * builds and hand edits among them, so a field this build cannot use is left
 * out on its own, and never costs the space its profile or its PR links.
 */
function parseSpaceState(content: string): SpaceState {
	const record: unknown = JSON.parse(content);
	if (!isRecord(record)) throw new Error('Not a space state');
	const {pipeline, hasConflict, prLinks, recap} = record;
	const unresolvedCommentCount = integerOrNothing(
		record['unresolvedCommentCount'],
	);
	const prNumber = integerOrNothing(record['prNumber']);
	const updatedAt = stringOrNothing(record['updatedAt']);
	const profile = stringOrNothing(record['profile']);
	const issueTitle = stringOrNothing(record['issueTitle']);
	const agentProfile = parseAgentProfile(record['agentProfile']);
	return {
		...(Array.isArray(prLinks)
			? {prLinks: prLinks.flatMap(link => parsePrLink(link) ?? [])}
			: {}),
		...(pipeline === null ||
		PIPELINE_STATUSES.includes(pipeline as PipelineStatus)
			? {pipeline: pipeline as PipelineStatus | null}
			: {}),
		...(unresolvedCommentCount === undefined ? {} : {unresolvedCommentCount}),
		...(prNumber === undefined ? {} : {prNumber}),
		...(typeof hasConflict === 'boolean' ? {hasConflict} : {}),
		...(isRecord(recap) ? {recap: parseRecap(recap)} : {}),
		...(updatedAt === undefined ? {} : {updatedAt}),
		...(profile === undefined ? {} : {profile}),
		...(issueTitle === undefined ? {} : {issueTitle}),
		...(agentProfile === undefined ? {} : {agentProfile}),
	};
}

/**
 * An agent-sessions file as the hook left it. An entry without a session id
 * is one no reader uses, and is left out.
 */
function parseAgentSessions(content: string): Map<string, AgentSession> {
	const record: unknown = JSON.parse(content);
	if (!isRecord(record)) throw new Error('Not an agent-sessions file');
	const sessions = new Map<string, AgentSession>();
	for (const [name, entry] of Object.entries(record)) {
		if (!isRecord(entry)) continue;
		const {session_id: sessionId, pid, started} = entry;
		if (!isString(sessionId)) continue;
		sessions.set(name, {
			sessionId,
			pid: Number.isInteger(pid) ? (pid as number) : null,
			started: isString(started) ? started : null,
		});
	}

	return sessions;
}

function parseIssueMeta(content: string): IssueMeta {
	const record = JSON.parse(content) as Record<string, unknown> | null;
	const createdByPappardelle = record?.['created_by_pappardelle'];
	const createdAt = record?.['created_at'];
	if (typeof createdByPappardelle !== 'boolean' || !isString(createdAt))
		throw new Error('Not an issue-meta record');
	return {createdByPappardelle, createdAt};
}

function parseStateColors(content: string): Map<string, string> {
	const colors = new Map<string, string>();
	const parsed = JSON.parse(content) as Record<string, unknown>;
	for (const [name, color] of Object.entries(parsed)) {
		if (isString(color)) colors.set(name, color);
	}

	return colors;
}

/** Entries that are not widths are left out. */
function parseCompanionWidths(content: string): Record<string, PaneWidth> {
	const parsed: unknown = JSON.parse(content);
	if (!isRecord(parsed)) throw new Error('Not a companion widths store');
	return Object.fromEntries(
		Object.entries(parsed).filter((entry): entry is [string, PaneWidth] =>
			isPaneWidth(entry[1]),
		),
	);
}

function parseJob(content: string): Job {
	const job = (JSON.parse(content) ?? {}) as Record<string, unknown>;
	const {kind, id, key} = job;
	if (!isString(id) || !isString(key)) throw new Error('Not a scheduled job');
	if (kind === 'keep_going') {
		const {everySeconds, nudge, until, idleChecks} = job;
		if (
			!Number.isInteger(everySeconds) ||
			!isString(nudge) ||
			!isOptionalString(until) ||
			!Number.isInteger(idleChecks)
		)
			throw new Error('Not a keep-going job');
		return {
			kind,
			id,
			key,
			everySeconds: everySeconds as number,
			nudge,
			until,
			idleChecks: idleChecks as number,
		};
	}

	const {at, message, arm, deferReason, deferCount} = job;
	if (
		(kind !== 'at' && kind !== 'after_limit') ||
		!isString(at) ||
		!isString(message) ||
		!Number.isInteger(arm)
	)
		throw new Error('Not a scheduled job');
	return {
		kind,
		id,
		key,
		at,
		message,
		arm: arm as number,
		...(isString(deferReason) ? {deferReason: deferReason as SendOutcome} : {}),
		...(Number.isInteger(deferCount) && (deferCount as number) > 0
			? {deferCount: deferCount as number}
			: {}),
	};
}

function parseHold(content: string): Hold {
	const hold = (JSON.parse(content) ?? {}) as Record<string, unknown>;
	const {id, key, tool, command, filePath, cwd, reason, state} = hold;
	const {createdAt, resolvedAt, approvable} = hold;
	if (
		!isString(id) ||
		!isString(key) ||
		!isString(tool) ||
		!isString(command) ||
		!isOptionalString(filePath) ||
		!isOptionalString(cwd) ||
		typeof approvable !== 'boolean' ||
		!isString(reason) ||
		!HOLD_STATES.includes(state as HoldState) ||
		!isString(createdAt) ||
		!isOptionalString(resolvedAt)
	)
		throw new Error('Not a hold');
	return {
		id,
		key,
		tool,
		command,
		filePath,
		cwd,
		approvable,
		reason,
		state: state as HoldState,
		createdAt,
		resolvedAt,
	};
}

function parseTuiMarker(content: string): TuiMarker {
	const parsed: unknown = JSON.parse(content);
	if (!isRecord(parsed)) throw new Error('Not a TUI marker');
	const {pid, cliPath, sha, paneId, startedAt} = parsed;
	if (
		typeof pid !== 'number' ||
		!isString(cliPath) ||
		!isString(sha) ||
		!isString(paneId) ||
		typeof startedAt !== 'number'
	)
		throw new Error('Not a TUI marker');
	return {pid, cliPath, sha, paneId, startedAt};
}

function parseCachedCheck(content: string): CacheEntry {
	const parsed = JSON.parse(content) as Partial<CacheEntry> | null;
	if (typeof parsed?.checkedAt !== 'number' || !isString(parsed.latestVersion))
		throw new Error('Not an update check');
	return {checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion};
}
