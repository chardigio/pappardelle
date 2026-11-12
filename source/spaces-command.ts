// `pappardelle spaces`: every open space with its Claude status, cached rail
// state and recap, issue title, PR link and branch summary. The JSON keeps
// the shape of the sous-chef's old gather-spaces.sh, which the board reads,
// and adds title, prUrl and git.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import type {ClaudeStatusDao} from './claude-status.ts';
import type {IssueMetaDao} from './issue-meta.ts';
import type {SpaceRegistryDao} from './space-registry.ts';
import {claudeProjectDir, type SpaceStateDao} from './space-state.ts';
import {getSessionNames} from './tmux.ts';
import {getIssues} from './tracker.ts';

const execFileAsync = promisify(execFile);

export interface GitSummary {
	base: string;
	ahead: number;
	filesChanged: number;
	insertions: number;
	deletions: number;
	/** New files git doesn't track yet; the line counts leave them out. */
	untracked: number;
}

export type SpaceEntry = {
	name: string;
	status: string;
	currentTool?: string | null;
	lastUpdate?: number | null;
	minutesAgo?: number;
	sessionId?: string | null;
	meta?: unknown;
	pipeline?: unknown;
	unresolvedCommentCount?: unknown;
	prNumber?: unknown;
	recap?: unknown;
	spaceStateUpdatedAt?: unknown;
	pid?: unknown;
	worktreePath?: unknown;
	conversationLog?: string;
	logModified?: number;
	logMinutesAgo?: number;
	tmuxSession: string;
	title: string | null;
	prUrl: string | null;
	git: GitSummary | null;
};

export type SpacesReport =
	| {totalSpaces: number; spaces: SpaceEntry[]; timestamp: number}
	| {error: string; spaces: []};

export interface SpacesDeps {
	repoName: string;
	registry: Pick<SpaceRegistryDao, 'openSpaces'>;
	claudeStatus: Pick<ClaudeStatusDao, 'readableKey' | 'readState'>;
	spaceState: Pick<SpaceStateDao, 'read'>;
	issueMeta: Pick<IssueMetaDao, 'read'>;
	home: string;
	now?: number;
	fetchTitles: (keys: string[]) => Promise<Map<string, string | null>>;
	gitSummary: (worktreePath: string) => Promise<GitSummary | null>;
	titleTimeoutMs?: number;
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundTenth(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * Claude Code's session file for each worktree of this repo, newest first
 * when one worktree has several. The prefix ends in `/` so `repo-api` never
 * matches `repo`.
 */
function sessionsByWorktree(
	home: string,
	repoName: string,
): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();
	const dir = path.join(home, '.claude', 'sessions');
	const prefix = path.join(home, '.worktrees', repoName) + '/';
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
	} catch {
		return map;
	}

	for (const file of files) {
		let session: unknown;
		try {
			session = readJson(path.join(dir, file));
		} catch {
			continue;
		}

		if (!isRecord(session) || typeof session['cwd'] !== 'string') continue;
		if (!session['cwd'].startsWith(prefix)) continue;
		const key = session['cwd'].slice(prefix.length).split('/')[0];
		if (!key) continue;
		const existing = map.get(key);
		const started = String(session['startedAt'] ?? '');
		if (!existing || started > String(existing['startedAt'] ?? ''))
			map.set(key, session);
	}

	return map;
}

function newestJsonl(
	projectDir: string,
): {file: string; mtimeMs: number} | null {
	let newest: {file: string; mtimeMs: number} | null = null;
	let entries: string[];
	try {
		entries = fs.readdirSync(projectDir);
	} catch {
		return null;
	}

	for (const name of entries) {
		if (!name.endsWith('.jsonl')) continue;
		const file = path.join(projectDir, name);
		try {
			const {mtimeMs} = fs.statSync(file);
			if (!newest || mtimeMs > newest.mtimeMs) newest = {file, mtimeMs};
		} catch {
			// Removed between readdir and stat
		}
	}

	return newest;
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	fallback: T,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.catch(() => fallback),
			new Promise<T>(resolve => {
				timer = setTimeout(() => {
					resolve(fallback);
				}, ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function gatherSpaces(deps: SpacesDeps): Promise<SpacesReport> {
	const {repoName, home} = deps;
	const now = deps.now ?? Date.now();
	let keys: string[] | null;
	try {
		keys = deps.registry.openSpaces();
	} catch (error) {
		// An agent reads this as the list of spaces. A registry that could not
		// be read must not tell it there are none.
		return {
			error: `Could not read the open spaces: ${error instanceof Error ? error.message : String(error)}`,
			spaces: [],
		};
	}

	if (!keys) return {error: 'No open spaces file found', spaces: []};

	const sessions = sessionsByWorktree(home, repoName);
	// bd alone can take several seconds on a busy machine; a title is worth the
	// wait for the board, but a hung tracker must not hold it forever.
	const titles = withTimeout(
		deps.fetchTitles(keys),
		deps.titleTimeoutMs ?? 15_000,
		new Map<string, string | null>(),
	);

	const entries = await Promise.all(
		keys.map(async (name): Promise<SpaceEntry> => {
			const entry: Partial<SpaceEntry> & {name: string} = {name};

			const stored = deps.claudeStatus.readState(
				deps.claudeStatus.readableKey(repoName, name),
			);
			if (stored.kind === 'state') {
				const {state} = stored;
				entry.status = state.status;
				entry.currentTool = state.currentTool ?? null;
				entry.lastUpdate = state.lastUpdate;
				if (entry.lastUpdate)
					entry.minutesAgo = roundTenth((now - entry.lastUpdate) / 60_000);
				entry.sessionId = state.sessionId;
			} else {
				entry.status = stored.kind === 'unreadable' ? 'unknown' : 'no_status';
			}

			const meta = deps.issueMeta.read(name);
			if (meta) {
				entry.meta = {
					created_by_pappardelle: meta.createdByPappardelle,
					created_at: meta.createdAt,
				};
			}

			const state = deps.spaceState.read(name);
			if (state) {
				for (const field of [
					'pipeline',
					'unresolvedCommentCount',
					'prNumber',
					'recap',
				] as const) {
					if (field in state) entry[field] = state[field];
				}

				if ('updatedAt' in state) entry.spaceStateUpdatedAt = state.updatedAt;
			}

			const prUrl = state?.prLinks?.at(-1)?.url ?? null;

			const session = sessions.get(name);
			if (session) {
				entry.pid = session['pid'];
				entry.worktreePath = session['cwd'];
			}

			const worktree = path.join(home, '.worktrees', repoName, name);
			const log = newestJsonl(
				claudeProjectDir(worktree, path.join(home, '.claude', 'projects')),
			);
			if (log) {
				entry.conversationLog = log.file;
				entry.logModified = log.mtimeMs / 1000;
				entry.logMinutesAgo = roundTenth((now - log.mtimeMs) / 60_000);
			}

			entry.tmuxSession = getSessionNames(name, repoName).agent;
			entry.prUrl = prUrl;
			entry.git = fs.existsSync(worktree)
				? await deps.gitSummary(worktree).catch(() => null)
				: null;
			const titleMap = await titles;
			entry.title = titleMap.get(name) ?? null;
			return entry as SpaceEntry;
		}),
	);

	entries.sort((a, b) => (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0));
	return {totalSpaces: keys.length, spaces: entries, timestamp: now};
}

async function git(cwd: string, args: string[]): Promise<string> {
	const {stdout} = await execFileAsync('git', args, {
		cwd,
		timeout: 5000,
		encoding: 'utf8',
	});
	return stdout.trim();
}

async function resolveBase(cwd: string): Promise<string | null> {
	try {
		return await git(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
	} catch {
		for (const branch of ['main', 'master']) {
			try {
				await git(cwd, ['rev-parse', '--verify', '--quiet', branch]);
				return branch;
			} catch {
				// Try the next name
			}
		}

		return null;
	}
}

export function parseShortstat(
	text: string,
): Pick<GitSummary, 'filesChanged' | 'insertions' | 'deletions'> {
	const count = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
	return {
		filesChanged: count(/(\d+) files? changed/),
		insertions: count(/(\d+) insertions?\(\+\)/),
		deletions: count(/(\d+) deletions?\(-\)/),
	};
}

/**
 * Commits ahead of the base branch, and the diff from where the branch left
 * it to the working tree, so uncommitted work counts and upstream changes
 * since then don't.
 */
export async function worktreeGitSummary(
	cwd: string,
): Promise<GitSummary | null> {
	const base = await resolveBase(cwd);
	if (!base) return null;
	const [ahead, mergeBase] = await Promise.all([
		git(cwd, ['rev-list', '--count', `${base}..HEAD`]),
		git(cwd, ['merge-base', base, 'HEAD']),
	]);
	const [stat, untracked] = await Promise.all([
		git(cwd, ['diff', '--shortstat', mergeBase]),
		git(cwd, ['ls-files', '--others', '--exclude-standard']),
	]);
	return {
		base,
		ahead: Number(ahead),
		...parseShortstat(stat),
		untracked: untracked ? untracked.split('\n').length : 0,
	};
}

function age(minutes: number | undefined): string {
	if (minutes === undefined) return '-';
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${Math.round(minutes)}m ago`;
	if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
	return `${Math.round(minutes / (60 * 24))}d ago`;
}

export function formatSpaces(report: SpacesReport): string {
	if ('error' in report) return report.error;
	if (report.spaces.length === 0) return 'No open spaces';
	return report.spaces
		.map(space => {
			const recap = isRecord(space.recap) ? space.recap : {};
			const title =
				space.title ??
				(typeof recap['customTitle'] === 'string' ? recap['customTitle'] : '');
			const flags = [
				space.git && space.git.ahead > 0 ? `+${space.git.ahead} commits` : '',
				space.git && space.git.untracked > 0
					? `+${space.git.untracked} new files`
					: '',
				space.pipeline === 'failing' ? '[pipeline red]' : '',
				typeof space.unresolvedCommentCount === 'number' &&
				space.unresolvedCommentCount > 0
					? `[${space.unresolvedCommentCount} unresolved]`
					: '',
			];
			return [space.name, space.status, age(space.minutesAgo), title, ...flags]
				.filter(Boolean)
				.join('  ');
		})
		.join('\n');
}

export async function runSpacesCommand(options: {
	repoName: string;
	registry: SpacesDeps['registry'];
	claudeStatus: SpacesDeps['claudeStatus'];
	spaceState: SpacesDeps['spaceState'];
	issueMeta: SpacesDeps['issueMeta'];
	home: string;
	json: boolean;
	out: (text: string) => void;
}): Promise<number> {
	const report = await gatherSpaces({
		repoName: options.repoName,
		registry: options.registry,
		claudeStatus: options.claudeStatus,
		spaceState: options.spaceState,
		issueMeta: options.issueMeta,
		home: options.home,
		async fetchTitles(keys) {
			const issues = await getIssues(keys);
			return new Map(
				[...issues].map(([key, issue]) => [key, issue?.title ?? null]),
			);
		},
		gitSummary: worktreeGitSummary,
	});
	options.out(
		options.json ? JSON.stringify(report, null, 2) : formatSpaces(report),
	);
	return 0;
}
