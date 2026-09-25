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
import {setImmediate as yieldToInput} from 'node:timers/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import type {PipelineStatus} from './providers/types.ts';

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
export async function findLatestSessionJsonl(
	worktreePath: string,
	projectsDir?: string,
): Promise<string | null> {
	const base = projectsDir ?? path.join(homedir(), '.claude', 'projects');
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(base, encoded);
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
			let pending = '';
			for await (const chunk of stream) {
				const contents = pending + (chunk as string);
				let start = 0;
				let end = contents.indexOf('\n');
				while (end !== -1) {
					applyRecapLine(recap, contents.slice(start, end));
					start = end + 1;
					end = contents.indexOf('\n', start);
					if (performance.now() - yieldedAt >= 4) {
						await yieldToInput();
						yieldedAt = performance.now();
					}
				}
				pending = contents.slice(start);
			}
			if (pending) applyRecapLine(recap, pending);
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
