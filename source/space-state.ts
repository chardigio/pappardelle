// Persisted per-space state file.
//
// Pappardelle caches derived-but-expensive-to-refetch data here so the
// sous-chef skill (and any other consumer) can brief the chef without
// shelling out to gh or reading the raw conversation jsonl itself.
//
// Layout: ~/.pappardelle/repos/{repoName}/space-state/{ISSUE-KEY}.json
//
// Written by the Pappardelle TUI after each rail-status poll. Reads are
// cheap and failure-tolerant — consumers should treat missing/malformed
// files the same as "no cached data yet".

import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {setImmediate as yieldToInput} from 'node:timers/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {PIPELINE_STATUSES, type PipelineStatus} from './providers/types.ts';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

export interface SpaceRecap {
	customTitle?: string;
	lastPrompt?: string;
	lastAssistantExcerpt?: string;
}

/** A PR or MR recorded for one checkout in a space by `pappardelle link-pr`. */
export type SpacePrLink = {
	host: string;
	project: string;
	localBranch: string;
	remoteBranch: string;
	url: string;
	number: number;
};

export interface SpaceState {
	prLinks?: SpacePrLink[];
	pipeline?: PipelineStatus | null;
	unresolvedCommentCount?: number;
	prNumber?: number;
	hasConflict?: boolean;
	recap?: SpaceRecap;
	updatedAt?: string;
	/**
	 * Profile name selected by `idow` at workspace-creation time. Lets the TUI
	 * resolve the profile (and its emoji) on first paint without waiting for the
	 * in-memory issue cache to fill via the background `getIssues()` batch.
	 * Written once per workspace creation; never updated by the rail-status poller.
	 */
	profile?: string;
}

/**
 * The fields a writer sets. A key present with the value `undefined` removes
 * that field, and a recap replaces the whole recap.
 */
export type SpaceStatePatch = Omit<SpaceState, 'prLinks' | 'updatedAt'>;

/** What the rail poll learns about a space. It never chooses the profile. */
export type RailStatusPatch = Omit<SpaceStatePatch, 'profile'>;

/** One repo's per-space state, a record per space key. */
export interface SpaceStateDao {
	/** The file that holds a space's record, for messages that name it. */
	file(key: string): string;
	/** Null when nothing is recorded, or the record cannot be read. */
	read(key: string): SpaceState | null;
	write(key: string, patch: SpaceStatePatch): Promise<void>;
	/** The result of one rail poll, for every space it covered. */
	writeRailStatuses(
		entries: Array<{key: string; patch: RailStatusPatch}>,
	): Promise<void>;
	/**
	 * Record `link` as the space's newest. A checkout (host, project and local
	 * branch) has one link, so an earlier one for the same checkout is replaced.
	 */
	addPrLink(key: string, link: SpacePrLink): Promise<void>;
}

export function withPrLink(
	links: SpacePrLink[],
	link: SpacePrLink,
): SpacePrLink[] {
	return [
		...links.filter(
			item =>
				!(
					item.host === link.host &&
					item.project === link.project &&
					item.localBranch === link.localBranch
				),
		),
		link,
	];
}

export function renderSpaceState(state: SpaceState): string {
	return JSON.stringify(state, null, 2) + '\n';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const stringOrNothing = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

const integerOrNothing = (value: unknown): number | undefined =>
	Number.isInteger(value) ? (value as number) : undefined;

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

function parsePrLink(value: unknown): SpacePrLink | undefined {
	if (!isRecord(value)) return undefined;
	const {host, project, localBranch, remoteBranch, url, number} = value;
	if (
		typeof host !== 'string' ||
		typeof project !== 'string' ||
		typeof localBranch !== 'string' ||
		typeof remoteBranch !== 'string' ||
		typeof url !== 'string' ||
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
 * The fields of a space-state file that hold what their writers leave there.
 * Throws when `content` is not a JSON object.
 *
 * The file has several writers, other builds and hand edits among them, and
 * the next write rewrites it from what was read. A field this build cannot
 * use is left out on its own, so it never costs the space its profile or its
 * PR links.
 */
export function parseSpaceState(content: string): SpaceState {
	const record: unknown = JSON.parse(content);
	if (!isRecord(record)) throw new Error('Not a space state');
	const {pipeline, hasConflict, prLinks, recap} = record;
	const unresolvedCommentCount = integerOrNothing(
		record['unresolvedCommentCount'],
	);
	const prNumber = integerOrNothing(record['prNumber']);
	const updatedAt = stringOrNothing(record['updatedAt']);
	const profile = stringOrNothing(record['profile']);
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
	};
}

/** Claude Code's transcript directory for a worktree. */
export function claudeProjectDir(
	worktreePath: string,
	projectsDir?: string,
): string {
	const base = projectsDir ?? path.join(homedir(), '.claude', 'projects');
	return path.join(
		base,
		worktreePath.replaceAll('/', '-').replaceAll('.', '-'),
	);
}

/**
 * Locate the most recently modified Claude Code session jsonl for a worktree.
 *
 * Claude Code stores transcripts under `~/.claude/projects/<encoded-cwd>/`,
 * where `<encoded-cwd>` is the absolute worktree path with `/` and `.` both
 * replaced by `-` (e.g. `/Users/me/.worktrees/repo/STA-1` →
 * `-Users-me--worktrees-repo-STA-1`). Returns the path of the newest
 * top-level `.jsonl` in that directory, or `null` if none exists.
 *
 * Subagent jsonls live in nested subdirectories (`subagents/*.jsonl`) and are
 * intentionally excluded so the recap reflects the main session only.
 */
export async function findLatestSessionJsonl(
	worktreePath: string,
	projectsDir?: string,
): Promise<string | null> {
	const projectDir = claudeProjectDir(worktreePath, projectsDir);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(projectDir, {withFileTypes: true});
	} catch {
		return null;
	}

	let newest: {file: string; mtime: number} | null = null;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
		const file = path.join(projectDir, entry.name);
		try {
			const {mtimeMs: mtime} = await fs.promises.stat(file);
			if (!newest || mtime > newest.mtime) newest = {file, mtime};
		} catch {
			// Skip inaccessible files.
		}
	}

	return newest ? newest.file : null;
}

export function getSpaceStateDir(repoName: string, baseDir?: string): string {
	const base = baseDir ?? DEFAULT_BASE_DIR;
	return path.join(base, 'repos', repoName, 'space-state');
}

/** One agent profile's latest conversation in a space, as its hook records it. */
export type AgentSession = {
	sessionId: string;
	/** The agent process that recorded the id, and when it started. */
	pid: number | null;
	started: string | null;
};

/**
 * Each agent profile's latest conversation in a space, by agent profile name,
 * written only by the agent's SessionStart/UserPromptSubmit hook
 * (plugins/pappardelle/hooks/agent_session.py). It lives beside the space-state file rather than
 * in it: the TUI rewrites that file after every rail poll, and a hook write
 * landing between the TUI's read and its rename would be lost. Keyed by agent
 * profile so a one-launch override doesn't take the profile's own
 * conversation away. idow clears it when it creates a workspace for a new
 * issue, whose key can't own an earlier conversation.
 */
export interface AgentSessionsDao {
	/** The file the hook writes for a space. The launchers hand it this path. */
	file(key: string): string;
	/** The session id an agent profile recorded in a space. */
	read(key: string, agentProfile: string): string | undefined;
	/**
	 * The agent profile whose agent started last in a space, which is the one
	 * running there: a picker override launches once without being saved
	 * anywhere else.
	 */
	latestProfile(key: string): string | undefined;
	/** The spaces that have recorded sessions. */
	keys(): string[];
	/**
	 * Move the session recorded under `from` to `to`. Nothing changes when
	 * `from` has none or `to` already has its own.
	 */
	renameProfile(key: string, from: string, to: string): Promise<void>;
	/** Forget every session recorded in a space. */
	clear(key: string): Promise<void>;
}

const AGENT_SESSIONS_SUFFIX = '.agent-sessions.json';

/**
 * An agent-sessions file as the hook leaves it. Throws when `content` is not
 * an object of entries. An entry without a session id is one no reader uses,
 * and is left out.
 */
export function parseAgentSessions(content: string): Map<string, AgentSession> {
	const record: unknown = JSON.parse(content);
	if (!isRecord(record)) throw new Error('Not an agent-sessions file');
	const sessions = new Map<string, AgentSession>();
	for (const [name, entry] of Object.entries(record)) {
		if (!isRecord(entry)) continue;
		const {session_id: sessionId, pid, started} = entry;
		if (typeof sessionId !== 'string') continue;
		sessions.set(name, {
			sessionId,
			pid: Number.isInteger(pid) ? (pid as number) : null,
			started: typeof started === 'string' ? started : null,
		});
	}

	return sessions;
}

export function renderAgentSessions(
	sessions: Iterable<[string, AgentSession]>,
): string {
	const entries = Object.fromEntries(
		[...sessions].map(([name, {sessionId, pid, started}]) => [
			name,
			{session_id: sessionId, pid, started},
		]),
	);
	return JSON.stringify(entries, null, 2) + '\n';
}

/**
 * The name whose agent started last. `started` is the agent process's start
 * time as the hook reads it from `ps -o lstart` (LC_ALL=C).
 */
export function latestStarted(
	entries: Iterable<[name: string, started: unknown]>,
): string | undefined {
	let latest: {name: string; started: number} | undefined;
	for (const [name, value] of entries) {
		const started = Date.parse(String(value));
		if (!Number.isNaN(started) && (!latest || started > latest.started)) {
			latest = {name, started};
		}
	}

	return latest?.name;
}

export class JsonAgentSessionsDao implements AgentSessionsDao {
	constructor(private readonly dir: string) {}

	file(key: string): string {
		return path.join(this.dir, `${key}${AGENT_SESSIONS_SUFFIX}`);
	}

	read(key: string, agentProfile: string): string | undefined {
		const entry = this.sessions(key)[agentProfile];
		const id =
			entry && typeof entry === 'object'
				? (entry as Record<string, unknown>)['session_id']
				: undefined;
		return typeof id === 'string' ? id : undefined;
	}

	latestProfile(key: string): string | undefined {
		return latestStarted(
			Object.entries(this.sessions(key)).map(([name, entry]) => [
				name,
				entry && typeof entry === 'object'
					? (entry as Record<string, unknown>)['started']
					: undefined,
			]),
		);
	}

	keys(): string[] {
		let files: string[];
		try {
			files = fs.readdirSync(this.dir);
		} catch {
			return [];
		}

		return files
			.filter(
				file =>
					file.endsWith(AGENT_SESSIONS_SUFFIX) &&
					file.length > AGENT_SESSIONS_SUFFIX.length,
			)
			.map(file => file.slice(0, -AGENT_SESSIONS_SUFFIX.length));
	}

	async renameProfile(key: string, from: string, to: string): Promise<void> {
		const file = this.file(key);
		try {
			const sessions: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (!isRecord(sessions) || !(from in sessions) || to in sessions) return;
			const moved = Object.fromEntries(
				Object.entries(sessions).map(([name, entry]) => [
					name === from ? to : name,
					entry,
				]),
			);
			const temporary = `${file}.tmp.${process.pid}`;
			fs.writeFileSync(temporary, JSON.stringify(moved, null, 2) + '\n');
			fs.renameSync(temporary, file);
		} catch {
			// The space relaunches with --continue instead.
		}
	}

	async clear(key: string): Promise<void> {
		fs.rmSync(this.file(key), {force: true});
	}

	private sessions(key: string): Record<string, unknown> {
		try {
			const sessions: unknown = JSON.parse(
				fs.readFileSync(this.file(key), 'utf-8'),
			);
			return sessions && typeof sessions === 'object'
				? (sessions as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
}

export class JsonSpaceStateDao implements SpaceStateDao {
	constructor(
		private readonly dir: string,
		private readonly clock: () => Date,
	) {}

	file(key: string): string {
		return path.join(this.dir, `${key}.json`);
	}

	read(key: string): SpaceState | null {
		try {
			const raw = fs.readFileSync(this.file(key), 'utf-8');
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as SpaceState;
			}
		} catch {
			// File missing, unreadable, or malformed — treat as "no state".
		}

		return null;
	}

	/**
	 * Merge `patch` into the existing state (if any) and write.
	 * Fields in `patch` overwrite existing values; fields not present are preserved.
	 * Always refreshes `updatedAt` to now.
	 */
	async write(key: string, patch: SpaceStatePatch): Promise<void> {
		const existing = this.read(key) ?? {};
		const next: SpaceState = {
			...existing,
			...patch,
			updatedAt: this.clock().toISOString(),
		};

		const p = this.file(key);
		try {
			fs.mkdirSync(path.dirname(p), {recursive: true});
			fs.writeFileSync(p, renderSpaceState(next));
		} catch {
			// Non-critical — cache will be rebuilt on next poll.
		}
	}

	async writeRailStatuses(
		entries: Array<{key: string; patch: RailStatusPatch}>,
	): Promise<void> {
		for (const {key, patch} of entries) await this.write(key, patch);
	}

	async addPrLink(key: string, link: SpacePrLink): Promise<void> {
		const state = this.read(key) ?? {};
		state.prLinks = withPrLink(state.prLinks ?? [], link);
		const file = this.file(key);
		fs.mkdirSync(path.dirname(file), {recursive: true});
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(temporary, renderSpaceState(state));
			fs.renameSync(temporary, file);
		} finally {
			fs.rmSync(temporary, {force: true});
		}
	}
}

const MAX_EXCERPT_LEN = 500;

const recapCache = new Map<
	string,
	{signature: string; recap: SpaceRecap | null}
>();
const MAX_CACHED_RECAPS = 128;

function fileSignature(stat: fs.Stats): string {
	return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

/**
 * Pull a lightweight recap out of a Claude Code session jsonl file.
 *
 * We look for three Claude-emitted line types:
 *  - `custom-title` — auto-generated short session label (3-6 words)
 *  - `last-prompt` — most recent user prompt text
 *  - `assistant` — most recent assistant message with non-empty text content
 *
 * Returns `null` when none of these are present or the file can't be read.
 */
export async function extractRecapFromJsonl(
	jsonlPath: string,
): Promise<SpaceRecap | null> {
	try {
		const signature = fileSignature(await fs.promises.stat(jsonlPath));
		const cached = recapCache.get(jsonlPath);
		if (cached?.signature === signature) {
			recapCache.delete(jsonlPath);
			recapCache.set(jsonlPath, cached);
			return cached.recap;
		}

		const recap: SpaceRecap = {};
		const stream = fs.createReadStream(jsonlPath, {encoding: 'utf-8'});
		try {
			let yieldedAt = performance.now();
			let pending: string[] = [];
			for await (const chunk of stream) {
				const contents = chunk as string;
				let start = 0;
				let end = contents.indexOf('\n');
				while (end !== -1) {
					const line = contents.slice(start, end);
					applyRecapLine(
						recap,
						pending.length ? pending.join('') + line : line,
					);
					pending = [];
					start = end + 1;
					end = contents.indexOf('\n', start);
					if (performance.now() - yieldedAt >= 4) {
						await yieldToInput();
						yieldedAt = performance.now();
					}
				}
				if (start < contents.length) pending.push(contents.slice(start));
			}
			if (pending.length) applyRecapLine(recap, pending.join(''));
		} finally {
			stream.destroy();
		}
		const result = Object.keys(recap).length ? recap : null;
		// A writer may append or replace the transcript while it is being read.
		// Only reuse snapshots that were stable for the entire read.
		if (fileSignature(await fs.promises.stat(jsonlPath)) === signature) {
			recapCache.delete(jsonlPath);
			recapCache.set(jsonlPath, {signature, recap: result});
			if (recapCache.size > MAX_CACHED_RECAPS) {
				recapCache.delete(recapCache.keys().next().value!);
			}
		}
		return result;
	} catch {
		recapCache.delete(jsonlPath);
		return null;
	}
}

function applyRecapLine(recap: SpaceRecap, line: string): void {
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!entry || typeof entry !== 'object') return;
	switch (entry.type) {
		case 'custom-title': {
			if (typeof entry.customTitle === 'string' && entry.customTitle) {
				recap.customTitle = entry.customTitle;
			}
			break;
		}
		case 'last-prompt': {
			if (typeof entry.lastPrompt === 'string' && entry.lastPrompt) {
				recap.lastPrompt = entry.lastPrompt;
			}
			break;
		}
		case 'assistant': {
			const text = extractAssistantText(entry);
			if (text) recap.lastAssistantExcerpt = text.slice(0, MAX_EXCERPT_LEN);
			break;
		}
		// No default
	}
}

export function extractAssistantText(entry: any): string | undefined {
	const msg = entry.message;
	if (!msg) return undefined;
	const {content} = msg;
	if (typeof content === 'string') {
		return content.trim() || undefined;
	}

	if (Array.isArray(content)) {
		const parts = content
			.filter(p => p && typeof p === 'object' && p.type === 'text')
			.map(p => (typeof p.text === 'string' ? p.text : ''))
			.filter(Boolean);
		const joined = parts.join(' ').trim();
		return joined || undefined;
	}

	return undefined;
}
