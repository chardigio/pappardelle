// `pappardelle spaces`: every open space with its agent status, cached rail
// state and recap, issue title, PR link and branch summary. The JSON keeps
// the shape of the sous-chef's old gather-spaces.sh, which the board reads,
// and adds title, prUrl and git.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {statusInfo, type ClaudeStatusDao} from './claude-status.ts';
import type {PappardelleConfig} from './config.ts';
import type {IssueMetaDao} from './issue-meta.ts';
import {
	listStatusPanes,
	type LocatedStatusPane,
	type ProgramStatusDao,
} from './program-status-monitor.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import type {SpaceRegistryDao} from './space-registry.ts';
import {
	findSpaceTranscript,
	resolveSpaceAgentKind,
	type AgentSessionsDao,
	type SpaceStateDao,
} from './space-state.ts';
import type {SpaceIdentity, SpaceIdentityDao} from './space-identity.ts';
import {getIssues} from './tracker.ts';
import {mergeProgramStatus} from './workspace-status.ts';

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
	tmuxSession: string | null;
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
	spaceIdentities: Pick<SpaceIdentityDao, 'get'>;
	claudeStatus: Pick<ClaudeStatusDao, 'readableKey' | 'readState'>;
	programStatus?: Pick<ProgramStatusDao, 'read'>;
	spaceState: Pick<SpaceStateDao, 'read'>;
	issueMeta: Pick<IssueMetaDao, 'read'>;
	agentSessions?: Pick<AgentSessionsDao, 'read'>;
	config?: PappardelleConfig | null;
	home: string;
	now?: number;
	fetchTitles: (keys: string[]) => Promise<Map<string, string | null>>;
	gitSummary: (worktreePath: string) => Promise<GitSummary | null>;
	listStatusPanes?: (socket: string) => Promise<Map<string, LocatedStatusPane>>;
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
 * Claude Code's newest session file in each space's stored worktree, by
 * space. A session in a subdirectory counts for the space whose worktree is
 * its nearest ancestor.
 */
function sessionsBySpace(
	home: string,
	worktrees: ReadonlyMap<string, string>,
): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();
	const dir = path.join(home, '.claude', 'sessions');
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
		const key = spaceHolding(session['cwd'], worktrees);
		if (!key) continue;
		const existing = map.get(key);
		const started = String(session['startedAt'] ?? '');
		if (!existing || started > String(existing['startedAt'] ?? ''))
			map.set(key, session);
	}

	return map;
}

function spaceHolding(
	cwd: string,
	worktrees: ReadonlyMap<string, string>,
): string | undefined {
	let found: {key: string; depth: number} | undefined;
	for (const [key, worktree] of worktrees) {
		if (cwd !== worktree && !cwd.startsWith(worktree + '/')) continue;
		if (!found || worktree.length > found.depth)
			found = {key, depth: worktree.length};
	}

	return found?.key;
}

function oscStatusLabel(info: ProgramStatusInfo): string {
	switch (info.status) {
		case 'blocked': {
			return 'waiting_for_approval';
		}

		case 'done':
		case 'idle': {
			return 'waiting_for_input';
		}

		case 'working': {
			return info.tool ? 'running_tool' : 'processing';
		}

		case 'error':
		case 'unknown': {
			return info.status;
		}
	}
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

	const identities = new Map<string, SpaceIdentity>();
	for (const key of keys) {
		const lookup = deps.spaceIdentities.get(key);
		if (lookup.kind === 'identity') identities.set(key, lookup.identity);
	}

	const sessions = sessionsBySpace(
		home,
		new Map(
			[...identities].map(([key, identity]) => [key, identity.worktreePath]),
		),
	);
	// bd alone can take several seconds on a busy machine; a title is worth the
	// wait for the board, but a hung tracker must not hold it forever.
	const titles = withTimeout(
		deps.fetchTitles(keys),
		deps.titleTimeoutMs ?? 15_000,
		new Map<string, string | null>(),
	);

	const paneReader = deps.listStatusPanes ?? listStatusPanes;
	const panesBySocket = new Map<string, Map<string, LocatedStatusPane>>();
	if (deps.programStatus) {
		const sockets = new Set(
			[...identities.values()].map(identity => identity.tmux.socket),
		);
		await Promise.all(
			[...sockets].map(async socket => {
				panesBySocket.set(socket, await paneReader(socket));
			}),
		);
	}

	const entries = await Promise.all(
		keys.map(async (name): Promise<SpaceEntry> => {
			const entry: Partial<SpaceEntry> & {name: string} = {name};
			const identity = identities.get(name);
			const state = deps.spaceState.read(name);
			const {kind} = resolveSpaceAgentKind(state, deps.config);
			const pane = identity
				? (panesBySocket
						.get(identity.tmux.socket)
						?.get(identity.tmux.agentSession)?.pane ?? null)
				: null;

			const [stored, snapshot] = await Promise.all([
				kind === 'claude'
					? deps.claudeStatus.readState(
							await deps.claudeStatus.readableKey(repoName, name),
						)
					: Promise.resolve({kind: 'none'} as const),
				deps.programStatus && pane
					? deps.programStatus.read(name, pane)
					: Promise.resolve(null),
			]);
			const hookState = stored.kind === 'state' ? stored.state : null;
			const hookInfo = hookState ? statusInfo(hookState) : null;
			if (snapshot?.authoritative && pane) {
				const merged = mergeProgramStatus(hookInfo, snapshot, pane);
				const hookStatus = kind === 'claude' ? hookState?.status : undefined;
				if (snapshot.exited || pane.dead) {
					entry.status = 'ended';
				} else if (hookStatus === 'ended' || hookStatus === 'compacting') {
					entry.status = hookStatus;
				} else {
					entry.status = merged ? oscStatusLabel(merged) : 'unknown';
				}

				entry.currentTool =
					entry.status === 'ended' ? null : (merged?.tool ?? null);
				entry.lastUpdate = hookState
					? Math.max(snapshot.updatedAt, hookState.lastUpdate)
					: snapshot.updatedAt;
				if (hookState) entry.sessionId = hookState.sessionId;
			} else if (hookState) {
				entry.status = hookState.status;
				entry.currentTool = hookState.currentTool ?? null;
				entry.lastUpdate = hookState.lastUpdate;
				entry.sessionId = hookState.sessionId;
			} else {
				entry.status = stored.kind === 'unreadable' ? 'unknown' : 'no_status';
			}

			if (entry.lastUpdate)
				entry.minutesAgo = roundTenth((now - entry.lastUpdate) / 60_000);

			const meta = deps.issueMeta.read(name);
			if (meta) {
				entry.meta = {
					created_by_pappardelle: meta.createdByPappardelle,
					created_at: meta.createdAt,
				};
			}

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

			if (kind === 'claude') {
				const session = sessions.get(name);
				if (session) {
					entry.pid = session['pid'];
					entry.worktreePath = session['cwd'];
				}
			}

			const worktree = identity?.worktreePath ?? null;
			const log = await findSpaceTranscript({
				issueKey: name,
				worktreePath: worktree,
				state,
				agentSessions: deps.agentSessions,
				config: deps.config,
				home,
			});
			if (log) {
				entry.conversationLog = log.file;
				entry.logModified = log.mtimeMs / 1000;
				entry.logMinutesAgo = roundTenth((now - log.mtimeMs) / 60_000);
			}

			entry.tmuxSession = identity?.tmux.agentSession ?? null;
			entry.prUrl = prUrl;
			entry.git =
				worktree && fs.existsSync(worktree)
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
	spaceIdentities: SpacesDeps['spaceIdentities'];
	claudeStatus: SpacesDeps['claudeStatus'];
	programStatus?: SpacesDeps['programStatus'];
	spaceState: SpacesDeps['spaceState'];
	issueMeta: SpacesDeps['issueMeta'];
	agentSessions?: SpacesDeps['agentSessions'];
	config?: SpacesDeps['config'];
	home: string;
	json: boolean;
	out: (text: string) => void;
}): Promise<number> {
	const report = await gatherSpaces({
		repoName: options.repoName,
		registry: options.registry,
		spaceIdentities: options.spaceIdentities,
		claudeStatus: options.claudeStatus,
		programStatus: options.programStatus,
		spaceState: options.spaceState,
		issueMeta: options.issueMeta,
		agentSessions: options.agentSessions,
		config: options.config,
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
