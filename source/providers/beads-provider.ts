import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {getMainRepoRoot} from '../config.ts';
import {issueKeyPrefix} from '../issue-utils.ts';
import {createLogger} from '../logger.ts';
import {sanitizeSubprocessError} from '../sanitize-error.ts';
import {displayPopup} from '../tmux.ts';
import {pLimit} from './concurrency.ts';
import {StateColorCache} from './state-color-cache.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerProviderName,
} from './types.ts';

const execFileAsync = promisify(execFile);

const log = createLogger('beads-provider');
const CACHE_TTL_MS = 60_000;
export const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// `bd list`/`bd ready` cap results (50 and 100 respectively) unless told not to.
// The rail and the watchlist both want the complete set.
const NO_LIMIT = ['-n', '0'];

const NON_WORK_TYPES = [
	'--exclude-type',
	'epic,convoy,molecule,event,merge-request',
];

export function isEnoent(err: unknown): boolean {
	return (
		err instanceof Error &&
		'code' in err &&
		(err as NodeJS.ErrnoException).code === 'ENOENT'
	);
}

async function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

interface CacheEntry {
	issue: TrackerIssue | null;
	timestamp: number;
}

/**
 * Beads status -> color. Beads exposes no per-status color of its own. These
 * are ANSI names rather than hex so they follow the user's terminal theme.
 */
const BEADS_STATUS_COLORS: Record<string, string> = {
	open: 'gray',
	in_progress: 'blue',
	blocked: 'yellow',
	deferred: 'magenta',
	closed: 'green',
	pinned: 'yellowBright',
	hooked: 'magentaBright',
};

const FALLBACK_STATUS_COLOR = 'gray';

/** Best effort — a temp directory that outlives us is harmless, a throw is not. */
function removeQuietly(dir: string | undefined): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, {recursive: true, force: true});
	} catch {
		// Nothing useful to do about a temp directory we cannot remove.
	}
}

export function normalizeBeadsStatus(status: string): string {
	return status.trim().toLowerCase().replace(/\s+/g, '_');
}

const READY_STATUSES = new Set(['open']);

export function unreachableReadyStatuses(statuses: string[]): string[] {
	return statuses.filter(s => {
		const normalized = normalizeBeadsStatus(s);
		return normalized !== '' && !READY_STATUSES.has(normalized);
	});
}

/**
 * `auto_remove_when_done` keys off the Linear-flavored state types in
 * `auto-remove.ts` (`completed`/`canceled`), so beads' terminal status has to
 * be reported under that name. Every other status passes through verbatim —
 * beads supports user-defined statuses via its `status.custom` config key and
 * an unknown one must never throw.
 */
export function beadsStateType(status: string): string {
	return status === 'closed' ? 'completed' : status;
}

export function beadsStateName(status: string): string {
	return status
		.split('_')
		.map(word => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
		.join(' ');
}

export function beadsIssuePrefix(issueId: string): string {
	const prefix = issueKeyPrefix(issueId);
	return prefix === issueId.split('.')[0] ? '' : prefix;
}

export function unwrapBeadsJson(
	stdout: string,
): Array<Record<string, unknown>> {
	const parsed = JSON.parse(stdout) as unknown;
	const payload =
		parsed !== null &&
		typeof parsed === 'object' &&
		!Array.isArray(parsed) &&
		'data' in parsed
			? (parsed as {data: unknown}).data
			: parsed;

	if (Array.isArray(payload)) {
		return payload.filter(
			(item): item is Record<string, unknown> =>
				item !== null && typeof item === 'object',
		);
	}

	if (payload !== null && typeof payload === 'object') {
		return [payload as Record<string, unknown>];
	}

	return [];
}

/**
 * `bd --json` is schema'd but not validated by us, so every field is read
 * through here: a row that arrives with a number where a string belongs
 * degrades to the default rather than throwing halfway through a batch and
 * taking the rest of the list with it.
 */
function stringField(raw: Record<string, unknown>, key: string): string {
	const value = raw[key];
	return typeof value === 'string' ? value : '';
}

export function mapBeadsIssue(raw: Record<string, unknown>): TrackerIssue {
	const identifier = stringField(raw, 'id');
	const status = stringField(raw, 'status') || 'open';
	const prefix = beadsIssuePrefix(identifier);

	const rawLabels = raw['labels'];
	const labels = Array.isArray(rawLabels)
		? (rawLabels as unknown[]).filter((l): l is string => typeof l === 'string')
		: undefined;

	return {
		identifier,
		title: stringField(raw, 'title'),
		state: {
			name: beadsStateName(status),
			type: beadsStateType(status),
			color: BEADS_STATUS_COLORS[status] ?? FALLBACK_STATUS_COLOR,
		},
		project: prefix ? {name: prefix, key: prefix} : null,
		labels,
	};
}

export function buildIssuePopupArgv(
	mainRoot: string,
	issueKey: string,
): string[] {
	return ['bd', '-C', mainRoot, 'show', `--id=${issueKey}`, '--long'];
}

export type CliExecutor = (
	command: string,
	args: string[],
	options: {
		encoding: BufferEncoding;
		timeout: number;
		cwd: string;
		env: NodeJS.ProcessEnv;
	},
) => Promise<string>;

export type SleepFn = (ms: number) => Promise<void>;

export class BeadsProvider implements IssueTrackerProvider {
	get name(): TrackerProviderName {
		return 'beads';
	}

	private readonly issueCache = new Map<string, CacheEntry>();
	private readonly stateColors: StateColorCache;
	private readonly execCli: CliExecutor;
	private readonly sleepFn: SleepFn;
	private readonly resolveCwd: () => string;
	private bdMissing = false;
	private currentUserCache?: Promise<string | undefined>;

	constructor(
		execCli?: CliExecutor,
		sleepFn?: SleepFn,
		stateColorCache?: StateColorCache,
		resolveCwd?: () => string,
	) {
		this.execCli =
			execCli ??
			(async (cmd, args, opts) => {
				const {stdout} = await execFileAsync(cmd, args, opts);
				return stdout;
			});
		this.sleepFn = sleepFn ?? defaultSleep;
		this.stateColors = stateColorCache ?? new StateColorCache();
		this.resolveCwd = resolveCwd ?? getMainRepoRoot;
	}

	/**
	 * Every `bd` call runs from the main repo root — not the worktree, which
	 * carries its own checked-out `.beads/` that bd would auto-discover — so
	 * all workspaces read and write the one canonical database. Asks for the
	 * enveloped JSON so the shape stays stable across the 2.0 default flip.
	 * Only stdout is parsed: pre-2.0 releases put a deprecation notice for
	 * bare `--json` on stderr.
	 */
	private async runBd(args: string[], timeout: number): Promise<string> {
		return this.execCli('bd', args, {
			encoding: 'utf-8',
			timeout,
			cwd: this.resolveCwd(),
			env: {...process.env, BD_JSON_ENVELOPE: '1'},
		});
	}

	private cache(issue: TrackerIssue, requestedKey?: string): void {
		const entry = {issue, timestamp: Date.now()};
		this.issueCache.set(issue.identifier, entry);
		if (requestedKey && requestedKey !== issue.identifier) {
			this.issueCache.set(requestedKey, entry);
		}

		this.stateColors.update(issue.state.name, issue.state.color);
	}

	private noteMissing(action: string): void {
		this.bdMissing = true;
		log.warn(
			`bd binary not found on PATH — beads ${action} disabled. Install beads or check your PATH.`,
		);
	}

	async getIssue(issueKey: string): Promise<TrackerIssue | null> {
		if (this.bdMissing) {
			return this.issueCache.get(issueKey)?.issue ?? null;
		}

		const cached = this.issueCache.get(issueKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			if (cached.issue) {
				this.stateColors.update(
					cached.issue.state.name,
					cached.issue.state.color,
				);
			}

			return cached.issue;
		}

		let lastError: unknown;
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				// `--id=` rather than a positional: an ID whose prefix starts with
				// a dash reaches bd's flag parser as a flag ("unknown shorthand
				// flag: 'e' in -eird-xyz"). Subcommands with no --id take `--`
				// instead; see closeIssue.
				const output = await this.runBd(
					['show', `--id=${issueKey}`, '--json'],
					20_000,
				);
				const rows = unwrapBeadsJson(output);
				const row =
					rows.find(r => r['id'] === issueKey) ?? rows[0] ?? undefined;
				if (!row) {
					this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
					return null;
				}

				const issue = mapBeadsIssue(row);
				this.cache(issue, issueKey);
				log.debug(`Fetched beads issue ${issueKey}: ${issue.title}`);
				return issue;
			} catch (err) {
				if (isEnoent(err)) {
					this.noteMissing('issue fetching');
					this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
					return null;
				}

				lastError = err;
				if (attempt < MAX_RETRIES) {
					log.debug(
						`Fetch beads issue ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
					);
					await this.sleepFn(RETRY_DELAY_MS);
				}
			}
		}

		log.warn(
			`Failed to fetch beads issue ${issueKey} after ${MAX_RETRIES} attempts`,
			sanitizeSubprocessError(lastError),
		);
		this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
		return null;
	}

	async getIssues(
		issueKeys: string[],
	): Promise<Map<string, TrackerIssue | null>> {
		const results = new Map<string, TrackerIssue | null>();
		if (issueKeys.length === 0) return results;

		if (this.bdMissing) {
			for (const key of issueKeys) {
				results.set(key, this.issueCache.get(key)?.issue ?? null);
			}

			return results;
		}

		try {
			const output = await this.runBd(
				['list', `--id=${issueKeys.join(',')}`, '--json', ...NO_LIMIT],
				30_000,
			);
			const found = new Set<string>();

			for (const row of unwrapBeadsJson(output)) {
				const issue = mapBeadsIssue(row);
				if (!issue.identifier) continue;
				found.add(issue.identifier);
				results.set(issue.identifier, issue);
				this.cache(issue);
			}

			const unresolved = issueKeys.filter(key => !found.has(key));
			if (unresolved.length > 0) {
				const fetched = await pLimit(
					unresolved.map(
						key => async () =>
							this.getIssue(key).then(
								issue => [key, issue] as [string, TrackerIssue | null],
							),
					),
					3,
				);
				for (const entry of fetched) {
					if (entry) results.set(entry[0], entry[1]);
				}
			}

			return results;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('issue fetching');
				for (const key of issueKeys) {
					results.set(key, this.issueCache.get(key)?.issue ?? null);
				}

				return results;
			}

			log.debug('Batch bd list failed, falling back to individual fetches');
		}

		const fetched = await pLimit(
			issueKeys.map(
				key => async () =>
					this.getIssue(key).then(
						issue => [key, issue] as [string, TrackerIssue | null],
					),
			),
			3,
		);
		for (const entry of fetched) {
			if (entry) results.set(entry[0], entry[1]);
		}

		return results;
	}

	getIssueCached(issueKey: string): TrackerIssue | null {
		return this.issueCache.get(issueKey)?.issue ?? null;
	}

	getWorkflowStateColor(stateName: string): string | null {
		return (
			this.stateColors.get(stateName) ??
			BEADS_STATUS_COLORS[stateName.toLowerCase().replace(/\s+/g, '_')] ??
			null
		);
	}

	clearCache(): void {
		this.issueCache.clear();
	}

	/**
	 * Beads issues are local — there is nothing to open in a browser. The rail's
	 * `o` key goes through `openIssue()` instead; this stays empty so any caller
	 * that still reaches for a URL degrades to "no link" rather than launching a
	 * browser at a bogus address.
	 */
	buildIssueUrl(): string {
		return '';
	}

	openIssue(issueKey: string): boolean {
		return displayPopup(buildIssuePopupArgv(this.resolveCwd(), issueKey));
	}

	async searchAssignedIssues(
		assignee: string | undefined,
		statuses: string[],
	): Promise<TrackerIssue[]> {
		if (this.bdMissing) return [];

		const args = ['ready', '--json', ...NO_LIMIT, ...NON_WORK_TYPES];
		const who = assignee === 'me' ? await this.currentUser() : assignee;
		if (who) args.push('--assignee', who);

		const wanted = new Set(statuses.map(s => normalizeBeadsStatus(s)));
		log.info(
			`Watchlist query: bd ready${who ? ` --assignee ${who}` : ''}${
				wanted.size > 0 ? ` (statuses: ${statuses.join(', ')})` : ''
			}`,
		);

		const unreachable = unreachableReadyStatuses(statuses);
		if (unreachable.length > 0) {
			log.warn(
				`issue_watchlist.statuses includes ${unreachable.join(', ')}, which \`bd ready\` never returns — it excludes in_progress, blocked, deferred and hooked issues. Those statuses will match nothing.`,
			);
		}

		try {
			const output = await this.runBd(args, 30_000);
			const results: TrackerIssue[] = [];

			for (const row of unwrapBeadsJson(output)) {
				const issue = mapBeadsIssue(row);
				if (!issue.identifier) continue;
				if (
					wanted.size > 0 &&
					!wanted.has(normalizeBeadsStatus(issue.state.type)) &&
					!wanted.has(normalizeBeadsStatus(issue.state.name))
				) {
					continue;
				}

				results.push(issue);
				this.cache(issue);
			}

			if (results.length > 0) {
				log.info(
					`Watchlist results: ${results.map(i => `${i.identifier} (${i.state.name})`).join(', ')}`,
				);
			} else {
				log.info('Watchlist results: none');
			}

			return results;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('issue search');
				return [];
			}

			log.warn('Failed to search beads issues', sanitizeSubprocessError(err));
			return [];
		}
	}

	async listReadyIssues(): Promise<TrackerIssue[]> {
		if (this.bdMissing) return [];

		try {
			const output = await this.runBd(['ready', '--json', ...NO_LIMIT], 10_000);
			const results: TrackerIssue[] = [];

			for (const row of unwrapBeadsJson(output)) {
				const issue = mapBeadsIssue(row);
				if (!issue.identifier) continue;
				results.push(issue);
				this.cache(issue);
			}

			return results;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('ready issue listing');
				return [];
			}

			log.warn(
				'Failed to list ready beads issues',
				sanitizeSubprocessError(err),
			);
			return [];
		}
	}

	async closeIssue(issueKey: string): Promise<boolean> {
		if (this.bdMissing) return false;

		try {
			// `close`, `update` and `comments add` take the ID positionally and
			// offer no --id escape, so `--` is what stops a dash-led prefix from
			// being parsed as a flag. Same hazard getIssue guards with `--id=`.
			await this.runBd(['close', '--', issueKey], 30_000);
			this.issueCache.delete(issueKey);
			return true;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('issue closing');
				return false;
			}

			log.warn(
				`Failed to close beads ${issueKey}`,
				sanitizeSubprocessError(err),
			);
			return false;
		}
	}

	async claimIssue(issueKey: string): Promise<boolean> {
		if (this.bdMissing) return false;

		try {
			await this.runBd(['update', '--claim', '--', issueKey], 30_000);
			this.issueCache.delete(issueKey);
			return true;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('issue claiming');
				return false;
			}

			log.warn(
				`Failed to claim beads ${issueKey}`,
				sanitizeSubprocessError(err),
			);
			return false;
		}
	}

	async createComment(issueKey: string, body: string): Promise<boolean> {
		if (this.bdMissing) return false;

		// Via a file rather than an argv entry: comment bodies are whole Q&A
		// transcripts, well past a comfortable argument length.
		// Staged inside a private 0700 directory rather than at a name derived
		// from pid and clock: `os.tmpdir()` is shared and world-writable on
		// Linux, where a predictable path lets another user pre-plant a symlink
		// that the write would follow.
		let bodyDir: string | undefined;
		let bodyPath: string | undefined;
		try {
			bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-beads-'));
			bodyPath = path.join(bodyDir, 'comment.md');
			fs.writeFileSync(bodyPath, body, {mode: 0o600});
		} catch (err) {
			log.warn(
				'Failed to stage beads comment body',
				sanitizeSubprocessError(err),
			);
			// mkdtemp can succeed and the write still fail (ENOSPC, a restrictive
			// umask). The finally below belongs to the *next* try, so without this
			// the private directory is orphaned on every failed AskUserQuestion.
			removeQuietly(bodyDir);
			return false;
		}

		try {
			let lastError: unknown;
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				try {
					await this.runBd(
						['comments', 'add', '-f', bodyPath, '--', issueKey],
						30_000,
					);
					return true;
				} catch (err) {
					if (isEnoent(err)) {
						this.noteMissing('comment posting');
						return false;
					}

					lastError = err;
					if (attempt < MAX_RETRIES) {
						log.debug(
							`Post comment on beads ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
						);
						await this.sleepFn(RETRY_DELAY_MS);
					}
				}
			}

			log.warn(
				`Failed to post comment on beads ${issueKey} after ${MAX_RETRIES} attempts`,
				sanitizeSubprocessError(lastError),
			);
			return false;
		} finally {
			removeQuietly(bodyDir);
		}
	}

	private async currentUser(): Promise<string | undefined> {
		this.currentUserCache ??= this.resolveCurrentUser();
		return this.currentUserCache;
	}

	private async resolveCurrentUser(): Promise<string | undefined> {
		const fromEnv = process.env['BEADS_ACTOR']?.trim();
		if (fromEnv) return fromEnv;

		try {
			const gitName = await this.execCli('git', ['config', 'user.name'], {
				encoding: 'utf-8',
				timeout: 5000,
				cwd: this.resolveCwd(),
				env: process.env,
			});
			const name = gitName.trim();
			if (name) return name;
		} catch {
			// No git identity configured, or git is unavailable — fall through.
		}

		return process.env['USER'] ?? process.env['LOGNAME'] ?? undefined;
	}
}
