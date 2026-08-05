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

import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {PipelineStatus} from './providers/types.ts';
import type {AgentCli} from './types.ts';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

export interface SpaceRecap {
	customTitle?: string;
	lastPrompt?: string;
	lastAssistantExcerpt?: string;
}

export interface SpaceState {
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
export function findLatestSessionJsonl(
	worktreePath: string,
	projectsDir?: string,
): string | null {
	const base = projectsDir ?? path.join(homedir(), '.claude', 'projects');
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(base, encoded);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(projectDir, {withFileTypes: true});
	} catch {
		return null;
	}

	let newest: {file: string; mtime: number} | null = null;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
		const file = path.join(projectDir, entry.name);
		try {
			const mtime = fs.statSync(file).mtimeMs;
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

export function getSpaceStatePath(
	repoName: string,
	issueKey: string,
	baseDir?: string,
): string {
	return path.join(getSpaceStateDir(repoName, baseDir), `${issueKey}.json`);
}

export function readSpaceState(
	repoName: string,
	issueKey: string,
	baseDir?: string,
): SpaceState | null {
	const p = getSpaceStatePath(repoName, issueKey, baseDir);
	try {
		const raw = fs.readFileSync(p, 'utf-8');
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
 * Merge `patch` into the existing state (if any) and write atomically.
 * Fields in `patch` overwrite existing values; fields not present are preserved.
 * Always refreshes `updatedAt` to now.
 */
export function writeSpaceState(
	repoName: string,
	issueKey: string,
	patch: SpaceState,
	baseDir?: string,
): void {
	const existing = readSpaceState(repoName, issueKey, baseDir) ?? {};
	const next: SpaceState = {
		...existing,
		...patch,
		updatedAt: new Date().toISOString(),
	};

	const p = getSpaceStatePath(repoName, issueKey, baseDir);
	try {
		fs.mkdirSync(path.dirname(p), {recursive: true});
		fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n');
	} catch {
		// Non-critical — cache will be rebuilt on next poll.
	}
}

const MAX_EXCERPT_LEN = 500;

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
export function extractRecapFromJsonl(jsonlPath: string): SpaceRecap | null {
	let raw: string;
	try {
		raw = fs.readFileSync(jsonlPath, 'utf-8');
	} catch {
		return null;
	}

	let customTitle: string | undefined;
	let lastPrompt: string | undefined;
	let lastAssistantExcerpt: string | undefined;

	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (!entry || typeof entry !== 'object') continue;

		const t = entry.type;
		switch (t) {
			case 'custom-title': {
				if (typeof entry.customTitle === 'string' && entry.customTitle) {
					customTitle = entry.customTitle;
				}

				break;
			}
			case 'last-prompt': {
				if (typeof entry.lastPrompt === 'string' && entry.lastPrompt) {
					lastPrompt = entry.lastPrompt;
				}

				break;
			}
			case 'assistant': {
				const text = extractAssistantText(entry);
				if (text) lastAssistantExcerpt = text.slice(0, MAX_EXCERPT_LEN);

				break;
			}
			// No default
		}
	}

	if (!customTitle && !lastPrompt && !lastAssistantExcerpt) return null;

	const recap: SpaceRecap = {};
	if (customTitle) recap.customTitle = customTitle;
	if (lastPrompt) recap.lastPrompt = lastPrompt;
	if (lastAssistantExcerpt) recap.lastAssistantExcerpt = lastAssistantExcerpt;
	return recap;
}

function extractAssistantText(entry: any): string | undefined {
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

// ============================================================================
// Codex transcripts
//
// Codex writes one JSONL "rollout" per thread under
// `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Unlike Claude, the
// path encodes the *date*, not the cwd — so a space's transcript is found by
// reading each rollout's `session_meta` header and matching its `cwd`.
//
// `~/.codex/state_5.sqlite` has a `threads` table indexing exactly this, but
// reading it would mean taking on a sqlite dependency for one lookup. Walking
// the date directories newest-first and stopping at the first cwd match costs a
// single line read per candidate file and needs nothing extra.
// ============================================================================

/** Cap on rollouts inspected before giving up, so an old sessions/ tree can't
 *  turn a 60s poll into a directory crawl. Newest-first ordering means the
 *  match is almost always in the first handful. */
const MAX_CODEX_ROLLOUTS_SCANNED = 250;

function readFirstLine(filePath: string): string | null {
	try {
		// Rollout headers are small; reading the file and splitting is simpler
		// than a streaming reader and fast enough at this call rate.
		const raw = fs.readFileSync(filePath, 'utf-8');
		const idx = raw.indexOf('\n');
		return idx === -1 ? raw : raw.slice(0, idx);
	} catch {
		return null;
	}
}

function rolloutCwd(filePath: string): string | null {
	const line = readFirstLine(filePath);
	if (!line?.trim()) return null;
	try {
		const entry = JSON.parse(line);
		if (entry?.type !== 'session_meta') return null;
		const cwd = entry?.payload?.cwd;
		return typeof cwd === 'string' ? cwd : null;
	} catch {
		return null;
	}
}

/** Directory entries sorted newest-first by name (ISO-ish names sort correctly). */
function sortedDirsDesc(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, {withFileTypes: true})
			.filter(e => e.isDirectory())
			.map(e => e.name)
			.sort((a, b) => b.localeCompare(a));
	} catch {
		return [];
	}
}

/**
 * Locate the most recently modified Codex rollout for a worktree, or null when
 * the worktree has never been opened in Codex.
 */
export function findLatestCodexRollout(
	worktreePath: string,
	sessionsDir?: string,
): string | null {
	const base = sessionsDir ?? path.join(homedir(), '.codex', 'sessions');
	const budget = {remaining: MAX_CODEX_ROLLOUTS_SCANNED};

	// Day directories, newest-first. Once a day yields a match there's no older
	// day that could beat it, so the first non-empty result wins outright.
	for (const dayDir of codexDayDirsNewestFirst(base)) {
		const matches = codexRolloutsInDay(dayDir, worktreePath, budget);
		if (matches.length > 0) {
			matches.sort((a, b) => b.mtime - a.mtime);
			return matches[0]!.file;
		}

		if (budget.remaining <= 0) break;
	}

	return null;
}

/** Every `<base>/YYYY/MM/DD` directory, newest-first. */
function codexDayDirsNewestFirst(base: string): string[] {
	const dirs: string[] = [];
	for (const year of sortedDirsDesc(base)) {
		const yearDir = path.join(base, year);
		for (const month of sortedDirsDesc(yearDir)) {
			const monthDir = path.join(yearDir, month);
			for (const day of sortedDirsDesc(monthDir)) {
				dirs.push(path.join(monthDir, day));
			}
		}
	}

	return dirs;
}

/**
 * Rollouts in one day directory whose `session_meta.cwd` matches, decrementing
 * the shared scan budget so an old sessions/ tree can't turn a poll into a
 * full directory crawl.
 */
function codexRolloutsInDay(
	dayDir: string,
	worktreePath: string,
	budget: {remaining: number},
): Array<{file: string; mtime: number}> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dayDir, {withFileTypes: true});
	} catch {
		return [];
	}

	const matches: Array<{file: string; mtime: number}> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
		if (budget.remaining <= 0) break;
		budget.remaining -= 1;

		const file = path.join(dayDir, entry.name);
		if (rolloutCwd(file) !== worktreePath) continue;
		try {
			matches.push({file, mtime: fs.statSync(file).mtimeMs});
		} catch {
			// Skip inaccessible files.
		}
	}

	return matches;
}

/**
 * Pull the same lightweight recap out of a Codex rollout that
 * `extractRecapFromJsonl` pulls out of a Claude transcript.
 *
 * Codex records conversation turns as `event_msg` entries with a `user_message`
 * or `agent_message` payload. Assistant messages carry a `phase`; only
 * `final_answer` is a real reply to the human — `commentary` is the running
 * narration Codex emits mid-turn, and surfacing that as "the last thing the
 * agent said" would routinely show a half-thought.
 *
 * `customTitle` is derived from the first user message, mirroring the label
 * Codex's own thread list shows. Codex has no curated short title of its own.
 */
export function extractRecapFromCodexRollout(
	rolloutPath: string,
): SpaceRecap | null {
	let raw: string;
	try {
		raw = fs.readFileSync(rolloutPath, 'utf-8');
	} catch {
		return null;
	}

	let firstPrompt: string | undefined;
	let lastPrompt: string | undefined;
	let lastFinalAnswer: string | undefined;
	let lastAnyAgentMessage: string | undefined;

	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (!entry || entry.type !== 'event_msg') continue;
		const {payload} = entry;
		if (!payload || typeof payload !== 'object') continue;
		const {message} = payload;
		if (typeof message !== 'string' || !message.trim()) continue;

		if (payload.type === 'user_message') {
			firstPrompt ??= message.trim();
			lastPrompt = message.trim();
		} else if (payload.type === 'agent_message') {
			lastAnyAgentMessage = message.trim();
			if (payload.phase === 'final_answer') {
				lastFinalAnswer = message.trim();
			}
		}
	}

	const lastAssistantExcerpt = (lastFinalAnswer ?? lastAnyAgentMessage)?.slice(
		0,
		MAX_EXCERPT_LEN,
	);

	if (!firstPrompt && !lastPrompt && !lastAssistantExcerpt) return null;

	const recap: SpaceRecap = {};
	if (firstPrompt) recap.customTitle = firstPrompt.slice(0, 80);
	if (lastPrompt) recap.lastPrompt = lastPrompt;
	if (lastAssistantExcerpt) recap.lastAssistantExcerpt = lastAssistantExcerpt;
	return recap;
}

/**
 * Read a space's recap through whichever harness owns its transcripts.
 *
 * The single entry point callers should use: the return type is identical
 * across harnesses, so adding a third one means adding a branch here and
 * nowhere else.
 */
export function readSpaceRecap(
	agent: AgentCli,
	worktreePath: string,
): SpaceRecap | null {
	if (agent === 'codex') {
		const rollout = findLatestCodexRollout(worktreePath);
		return rollout ? extractRecapFromCodexRollout(rollout) : null;
	}

	const jsonl = findLatestSessionJsonl(worktreePath);
	return jsonl ? extractRecapFromJsonl(jsonl) : null;
}
