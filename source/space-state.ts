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

const isOptionalString = (value: unknown): value is string | undefined =>
	value === undefined || typeof value === 'string';

const isOptionalInteger = (value: unknown): value is number | undefined =>
	value === undefined || Number.isInteger(value);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecap(value: unknown): SpaceRecap {
	if (!isRecord(value)) throw new Error('Not a recap');
	const {customTitle, lastPrompt, lastAssistantExcerpt} = value;
	if (
		!isOptionalString(customTitle) ||
		!isOptionalString(lastPrompt) ||
		!isOptionalString(lastAssistantExcerpt)
	)
		throw new Error('Not a recap');
	return {
		...(customTitle === undefined ? {} : {customTitle}),
		...(lastPrompt === undefined ? {} : {lastPrompt}),
		...(lastAssistantExcerpt === undefined ? {} : {lastAssistantExcerpt}),
	};
}

function parsePrLink(value: unknown): SpacePrLink {
	if (!isRecord(value)) throw new Error('Not a PR link');
	const {host, project, localBranch, remoteBranch, url, number} = value;
	if (
		typeof host !== 'string' ||
		typeof project !== 'string' ||
		typeof localBranch !== 'string' ||
		typeof remoteBranch !== 'string' ||
		typeof url !== 'string' ||
		!Number.isInteger(number)
	)
		throw new Error('Not a PR link');
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
 * A space-state file as its writers leave it. Throws when `content` is
 * anything else. Fields no writer sets are left out.
 */
export function parseSpaceState(content: string): SpaceState {
	const record: unknown = JSON.parse(content);
	if (!isRecord(record)) throw new Error('Not a space state');
	const {
		prLinks,
		pipeline,
		unresolvedCommentCount,
		prNumber,
		hasConflict,
		recap,
		updatedAt,
		profile,
	} = record;
	if (
		(prLinks !== undefined && !Array.isArray(prLinks)) ||
		(pipeline !== undefined &&
			pipeline !== null &&
			!PIPELINE_STATUSES.includes(pipeline as PipelineStatus)) ||
		!isOptionalInteger(unresolvedCommentCount) ||
		!isOptionalInteger(prNumber) ||
		(hasConflict !== undefined && typeof hasConflict !== 'boolean') ||
		!isOptionalString(updatedAt) ||
		!isOptionalString(profile)
	)
		throw new Error('Not a space state');
	return {
		...(prLinks === undefined
			? {}
			: {prLinks: (prLinks as unknown[]).map(link => parsePrLink(link))}),
		...(pipeline === undefined
			? {}
			: {pipeline: pipeline as PipelineStatus | null}),
		...(unresolvedCommentCount === undefined ? {} : {unresolvedCommentCount}),
		...(prNumber === undefined ? {} : {prNumber}),
		...(hasConflict === undefined ? {} : {hasConflict}),
		...(recap === undefined ? {} : {recap: parseRecap(recap)}),
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

/**
 * Each agent profile's latest conversation in a space, by agent profile name,
 * written only by the agent's SessionStart/UserPromptSubmit hook
 * (plugins/pappardelle/hooks/agent_session.py). It lives beside the space-state file rather than
 * in it: the TUI rewrites that file after every rail poll, and a hook write
 * landing between the TUI's read and its rename would be lost. Keyed by agent
 * profile so a one-launch override doesn't take the profile's own
 * conversation away. idow deletes it when it creates a workspace for a new
 * issue, whose key can't own an earlier conversation.
 */
export function getAgentSessionsPath(
	repoName: string,
	issueKey: string,
	baseDir?: string,
): string {
	return path.join(
		getSpaceStateDir(repoName, baseDir),
		`${issueKey}.agent-sessions.json`,
	);
}

function readAgentSessions(
	repoName: string,
	issueKey: string,
	baseDir?: string,
): Record<string, unknown> {
	try {
		const sessions: unknown = JSON.parse(
			fs.readFileSync(
				getAgentSessionsPath(repoName, issueKey, baseDir),
				'utf-8',
			),
		);
		return sessions && typeof sessions === 'object'
			? (sessions as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * The agent profile whose agent started last in a space, which is the one
 * running there: a picker override launches once without being saved
 * anywhere else. `started` is the agent process's start time as the hook
 * reads it from `ps -o lstart` (LC_ALL=C).
 */
export function latestAgentProfile(
	repoName: string,
	issueKey: string,
	baseDir?: string,
): string | undefined {
	let latest: {name: string; started: number} | undefined;
	for (const [name, entry] of Object.entries(
		readAgentSessions(repoName, issueKey, baseDir),
	)) {
		const started =
			entry && typeof entry === 'object'
				? Date.parse(String((entry as Record<string, unknown>)['started']))
				: Number.NaN;
		if (!Number.isNaN(started) && (!latest || started > latest.started)) {
			latest = {name, started};
		}
	}
	return latest?.name;
}

export function readAgentSession(
	repoName: string,
	issueKey: string,
	agentProfile: string,
	baseDir?: string,
): string | undefined {
	const entry = readAgentSessions(repoName, issueKey, baseDir)[agentProfile];
	const id =
		entry && typeof entry === 'object'
			? (entry as Record<string, unknown>)['session_id']
			: undefined;
	return typeof id === 'string' ? id : undefined;
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
