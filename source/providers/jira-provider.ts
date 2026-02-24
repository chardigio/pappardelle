// Jira issue tracker provider — wraps acli (Atlassian CLI)
import {execFileSync} from 'node:child_process';
import {createLogger} from '../logger.ts';
import type {IssueTrackerProvider, TrackerIssue} from './types.ts';

const log = createLogger('jira-provider');
const CACHE_TTL_MS = 60_000;
export const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

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
 * Map Jira statusCategory to a hex color.
 * Jira doesn't expose colors like Linear; we derive from statusCategory.
 */
const STATUS_CATEGORY_COLORS: Record<string, string> = {
	'To Do': '#95a2b3', // gray
	'In Progress': '#4b9fea', // blue
	Done: '#4caf50', // green
};

export function mapJiraIssue(raw: Record<string, unknown>): TrackerIssue {
	const fields = (raw['fields'] as Record<string, unknown>) ?? {};
	const status = (fields['status'] as Record<string, unknown>) ?? {};
	const statusCategory =
		(status['statusCategory'] as Record<string, unknown>) ?? {};
	const project = (fields['project'] as Record<string, unknown>) ?? {};
	const categoryName = (statusCategory['name'] as string) ?? 'To Do';

	return {
		identifier: raw['key'] as string,
		title: (fields['summary'] as string) ?? '',
		state: {
			name: (status['name'] as string) ?? '',
			type: categoryName.toLowerCase().replace(/\s+/g, '_'),
			color: STATUS_CATEGORY_COLORS[categoryName] ?? '#95a2b3',
		},
		project: project['name'] ? {name: project['name'] as string} : null,
	};
}

export type CliExecutor = (
	command: string,
	args: string[],
	options: {encoding: BufferEncoding; timeout: number},
) => string;

export type SleepFn = (ms: number) => Promise<void>;

export class JiraProvider implements IssueTrackerProvider {
	readonly name = 'jira';
	private readonly baseUrl: string;
	private readonly issueCache = new Map<string, CacheEntry>();
	private readonly stateColorMap = new Map<string, string>();
	private readonly execCli: CliExecutor;
	private readonly sleepFn: SleepFn;
	private acliMissing = false;

	constructor(baseUrl: string, execCli?: CliExecutor, sleepFn?: SleepFn) {
		// Strip trailing slash
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.execCli =
			execCli ?? ((cmd, args, opts) => execFileSync(cmd, args, opts));
		this.sleepFn = sleepFn ?? defaultSleep;
	}

	async getIssue(issueKey: string): Promise<TrackerIssue | null> {
		if (this.acliMissing) {
			return this.issueCache.get(issueKey)?.issue ?? null;
		}

		const cached = this.issueCache.get(issueKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			if (cached.issue) {
				this.stateColorMap.set(
					cached.issue.state.name,
					cached.issue.state.color,
				);
			}

			return cached.issue;
		}

		let lastError: unknown;
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				const output = this.execCli(
					'acli',
					['jira', 'workitem', 'view', issueKey, '--json'],
					{encoding: 'utf-8', timeout: 15_000},
				);
				const raw = JSON.parse(output) as Record<string, unknown>;
				const issue = mapJiraIssue(raw);
				this.issueCache.set(issueKey, {issue, timestamp: Date.now()});
				this.stateColorMap.set(issue.state.name, issue.state.color);
				log.debug(`Fetched Jira issue ${issueKey}: ${issue.title}`);
				return issue;
			} catch (err) {
				if (isEnoent(err)) {
					this.acliMissing = true;
					log.warn(
						'acli binary not found on PATH — Jira issue fetching disabled. Install acli or check your PATH.',
					);
					this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
					return null;
				}

				// execFileSync throws on non-zero exit codes, but acli may still
				// have written valid JSON to stdout (it exits 1 even on success).
				if (err && typeof err === 'object' && 'stdout' in err) {
					const {stdout} = err as {stdout: unknown};
					if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
						try {
							const raw = JSON.parse(stdout) as Record<string, unknown>;
							const issue = mapJiraIssue(raw);
							this.issueCache.set(issueKey, {issue, timestamp: Date.now()});
							this.stateColorMap.set(issue.state.name, issue.state.color);
							log.debug(
								`Fetched Jira issue ${issueKey} (from non-zero exit): ${issue.title}`,
							);
							return issue;
						} catch {
							/* stdout wasn't valid JSON after all */
						}
					}
				}

				lastError = err;
				if (attempt < MAX_RETRIES) {
					log.debug(
						`Fetch Jira issue ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
					);
					await this.sleepFn(RETRY_DELAY_MS);
				}
			}
		}

		log.warn(
			`Failed to fetch Jira issue ${issueKey} after ${MAX_RETRIES} attempts`,
			lastError instanceof Error ? lastError : undefined,
		);
		this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
		return null;
	}

	getIssueCached(issueKey: string): TrackerIssue | null {
		return this.issueCache.get(issueKey)?.issue ?? null;
	}

	getWorkflowStateColor(stateName: string): string | null {
		return (
			this.stateColorMap.get(stateName) ??
			STATUS_CATEGORY_COLORS[stateName] ??
			null
		);
	}

	clearCache(): void {
		this.issueCache.clear();
	}

	buildIssueUrl(issueKey: string): string {
		return `${this.baseUrl}/browse/${issueKey}`;
	}

	async createComment(issueKey: string, body: string): Promise<boolean> {
		if (this.acliMissing) {
			return false;
		}

		let lastError: unknown;
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				this.execCli(
					'acli',
					['jira', 'workitem', 'comment', '--key', issueKey, '--body', body],
					{encoding: 'utf-8', timeout: 30_000},
				);
				return true;
			} catch (err) {
				if (isEnoent(err)) {
					this.acliMissing = true;
					log.warn(
						'acli binary not found on PATH — Jira comment posting disabled.',
					);
					return false;
				}

				lastError = err;
				if (attempt < MAX_RETRIES) {
					log.debug(
						`Post comment on Jira ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
					);
					await this.sleepFn(RETRY_DELAY_MS);
				}
			}
		}

		log.warn(
			`Failed to post comment on Jira ${issueKey} after ${MAX_RETRIES} attempts`,
			lastError instanceof Error ? lastError : undefined,
		);
		return false;
	}
}
