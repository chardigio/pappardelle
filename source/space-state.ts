// Per-space state: data that is expensive to fetch again, kept so the
// sous-chef skill (and any other consumer) can brief the chef without
// shelling out to gh or reading the raw conversation jsonl itself. The TUI
// writes it after each rail-status poll.

import fs from 'node:fs';
import {setImmediate as yieldToInput} from 'node:timers/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {spaceAgentProfileName, type PappardelleConfig} from './config.ts';
import {isAgyCommand, isClaudeAgentProfile} from './config-launch-flags.ts';
import type {AgentSessionsDao} from './agent-sessions.ts';
import type {PipelineStatus} from './providers/types.ts';
import type {Unreadable} from './state-db.ts';

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
	/** The issue's title as the tracker last gave it to Pappardelle. */
	issueTitle?: string;
	/**
	 * The agent profile whose agent was last started in the space's agent
	 * session, which is the one running there: a picker override launches once
	 * and is saved nowhere else. The hook that records the agent's session id
	 * (plugins/pappardelle/hooks/agent_session.py) reads it.
	 */
	agentProfile?: LaunchedAgentProfile;
}

/** The agent profile an agent session was started with. */
export type LaunchedAgentProfile = {name: string; isClaude: boolean};

/**
 * The fields a writer sets. A key present with the value `undefined` removes
 * that field, and a recap replaces the whole recap.
 */
export type SpaceStatePatch = Omit<SpaceState, 'prLinks' | 'updatedAt'>;

/** What the rail poll learns about a space. It never chooses the profile. */
export type RailStatusPatch = Omit<
	SpaceStatePatch,
	'profile' | 'issueTitle' | 'agentProfile'
>;

/** What is recorded for one space. */
export type SpaceStateLookup =
	| {kind: 'state'; state: SpaceState}
	| {kind: 'none'}
	| Unreadable;

/** One repo's per-space state, a record per space key. */
export interface SpaceStateDao {
	/** Null when nothing is recorded, or the record cannot be read. */
	read(key: string): SpaceState | null;
	/** `read` for a caller that must not take an unreadable record for none. */
	lookup(key: string): SpaceStateLookup;
	write(key: string, patch: SpaceStatePatch): Promise<void>;
	/** Several spaces' patches at once, such as one rail poll's results. */
	writeMany(
		entries: Array<{key: string; patch: SpaceStatePatch}>,
	): Promise<void>;
	/**
	 * Record `link` as the space's newest. A checkout (host, project and local
	 * branch) has one link, so an earlier one for the same checkout is replaced.
	 */
	addPrLink(key: string, link: SpacePrLink): Promise<void>;
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

export type SpaceAgentKind = 'claude' | 'agy' | 'other';

export function resolveSpaceAgentKind(
	key: string,
	state: SpaceState | null,
	config?: PappardelleConfig | null,
): {kind: SpaceAgentKind; agentProfileName: string} {
	const launched = state?.agentProfile;
	const agentProfileName =
		launched?.name ??
		(config
			? spaceAgentProfileName(config, key, state?.issueTitle, state?.profile)
			: 'claude');
	const defined = config?.agent_profiles?.[agentProfileName];
	const isClaude =
		launched?.isClaude ??
		(defined ? isClaudeAgentProfile(defined) : agentProfileName === 'claude');
	if (isClaude) return {kind: 'claude', agentProfileName};
	const isAgy = defined
		? isAgyCommand(defined.command)
		: agentProfileName === 'agy';
	return {kind: isAgy ? 'agy' : 'other', agentProfileName};
}

/** Where agy stores the plain JSONL transcript for `conversationId`. */
export function agyTranscriptPath(
	conversationId: string,
	home = homedir(),
): string | null {
	if (
		!conversationId ||
		conversationId === '.' ||
		conversationId === '..' ||
		conversationId.includes('/') ||
		conversationId.includes('\\')
	) {
		return null;
	}

	return path.join(
		home,
		'.gemini',
		'antigravity-cli',
		'brain',
		conversationId,
		'.system_generated',
		'logs',
		'transcript.jsonl',
	);
}

export type TranscriptFormat = 'claude' | 'agy';

export interface SpaceTranscript {
	file: string;
	format: TranscriptFormat;
	mtimeMs: number;
}

/**
 * Locate the transcript for a space based on its active agent profile.
 * Non-Claude spaces never fall back to stale Claude logs under `~/.claude/projects`.
 */
export async function findSpaceTranscript(options: {
	issueKey: string;
	worktreePath: string | null;
	state?: SpaceState | null;
	agentSessions?: Pick<AgentSessionsDao, 'read'>;
	config?: PappardelleConfig | null;
	home?: string;
	claudeProjectsDir?: string;
}): Promise<SpaceTranscript | null> {
	const {kind, agentProfileName} = resolveSpaceAgentKind(
		options.issueKey,
		options.state ?? null,
		options.config,
	);
	if (kind === 'other') return null;

	let file: string | null = null;
	let format: TranscriptFormat;
	if (kind === 'agy') {
		const conversationId = options.agentSessions?.read(
			options.issueKey,
			agentProfileName,
		);
		file = conversationId
			? agyTranscriptPath(conversationId, options.home)
			: null;
		format = 'agy';
	} else {
		if (!options.worktreePath) return null;
		const projectsDir =
			options.claudeProjectsDir ??
			(options.home
				? path.join(options.home, '.claude', 'projects')
				: undefined);
		file = await findLatestSessionJsonl(options.worktreePath, projectsDir);
		format = 'claude';
	}

	if (!file) return null;
	try {
		const stat = await fs.promises.stat(file);
		return stat.isFile() ? {file, format, mtimeMs: stat.mtimeMs} : null;
	} catch {
		return null;
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

export function extractAgyUserText(content: unknown): string | undefined {
	if (typeof content !== 'string') return undefined;
	const match = /<USER_REQUEST>\s*([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(
		content,
	);
	const text = (match ? match[1]! : content).trim();
	return text || undefined;
}

/**
 * Pull a lightweight recap out of a Claude Code or agy transcript jsonl file.
 *
 * Returns `null` when none of the expected entries are present or the file
 * can't be read.
 */
export async function extractRecapFromJsonl(
	jsonlPath: string,
	format: TranscriptFormat = 'claude',
): Promise<SpaceRecap | null> {
	try {
		const signature = `${format}:${fileSignature(await fs.promises.stat(jsonlPath))}`;
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
						format,
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
			if (pending.length) applyRecapLine(recap, pending.join(''), format);
		} finally {
			stream.destroy();
		}
		const result = Object.keys(recap).length ? recap : null;
		// A writer may append or replace the transcript while it is being read.
		// Only reuse snapshots that were stable for the entire read.
		if (
			`${format}:${fileSignature(await fs.promises.stat(jsonlPath))}` ===
			signature
		) {
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

function applyRecapLine(
	recap: SpaceRecap,
	line: string,
	format: TranscriptFormat,
): void {
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!entry || typeof entry !== 'object') return;
	if (format === 'agy') {
		if (entry.type === 'USER_INPUT') {
			const prompt = extractAgyUserText(entry.content);
			if (prompt) recap.lastPrompt = prompt;
		} else if (entry.type === 'PLANNER_RESPONSE') {
			const text =
				typeof entry.content === 'string' ? entry.content.trim() : '';
			if (text) recap.lastAssistantExcerpt = text.slice(0, MAX_EXCERPT_LEN);
		}

		return;
	}

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
