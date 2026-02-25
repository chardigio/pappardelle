// Linear issue tracker provider — wraps linctl CLI
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLogger} from '../logger.ts';
import {StateColorCache} from './state-color-cache.ts';
import type {IssueTrackerProvider, TrackerIssue} from './types.ts';

const execFileAsync = promisify(execFile);

const log = createLogger('linear-provider');
const CACHE_TTL_MS = 60_000; // 60 seconds
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

export type CliExecutor = (
	command: string,
	args: string[],
	options: {encoding: BufferEncoding; timeout: number},
) => Promise<string>;

export type SleepFn = (ms: number) => Promise<void>;

interface CacheEntry {
	issue: TrackerIssue | null;
	timestamp: number;
}

export class LinearProvider implements IssueTrackerProvider {
	readonly name = 'linear';
	private readonly issueCache = new Map<string, CacheEntry>();
	private readonly stateColors: StateColorCache;
	private readonly execCli: CliExecutor;
	private readonly sleepFn: SleepFn;
	private linctlMissing = false;

	constructor(
		execCli?: CliExecutor,
		sleepFn?: SleepFn,
		stateColorCache?: StateColorCache,
	) {
		this.execCli =
			execCli ??
			(async (cmd, args, opts) => {
				const {stdout} = await execFileAsync(cmd, args, opts);
				return stdout;
			});
		this.sleepFn = sleepFn ?? defaultSleep;
		this.stateColors = stateColorCache ?? new StateColorCache();
	}

	async getIssue(issueKey: string): Promise<TrackerIssue | null> {
		if (this.linctlMissing) {
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
				const output = await this.execCli(
					'linctl',
					['issue', 'get', issueKey, '--json'],
					{encoding: 'utf-8', timeout: 10_000},
				);
				const issue = JSON.parse(output) as TrackerIssue;
				this.issueCache.set(issueKey, {issue, timestamp: Date.now()});
				this.stateColors.update(issue.state.name, issue.state.color);
				log.debug(`Fetched issue ${issueKey}: ${issue.title}`);
				return issue;
			} catch (err) {
				if (isEnoent(err)) {
					this.linctlMissing = true;
					log.warn(
						'linctl binary not found on PATH — Linear issue fetching disabled. Install linctl or check your PATH.',
					);
					this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
					return null;
				}

				lastError = err;
				if (attempt < MAX_RETRIES) {
					log.debug(
						`Fetch issue ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
					);
					await this.sleepFn(RETRY_DELAY_MS);
				}
			}
		}

		log.warn(
			`Failed to fetch issue ${issueKey} after ${MAX_RETRIES} attempts`,
			lastError instanceof Error ? lastError : undefined,
		);
		this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
		return null;
	}

	getIssueCached(issueKey: string): TrackerIssue | null {
		return this.issueCache.get(issueKey)?.issue ?? null;
	}

	getWorkflowStateColor(stateName: string): string | null {
		return this.stateColors.get(stateName);
	}

	clearCache(): void {
		this.issueCache.clear();
	}

	buildIssueUrl(issueKey: string): string {
		return `https://linear.app/stardust-labs/issue/${issueKey}`;
	}

	async createComment(issueKey: string, body: string): Promise<boolean> {
		if (this.linctlMissing) {
			return false;
		}

		let lastError: unknown;
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				await this.execCli(
					'linctl',
					['comment', 'create', issueKey, '--body', body],
					{encoding: 'utf-8', timeout: 30_000},
				);
				return true;
			} catch (err) {
				if (isEnoent(err)) {
					this.linctlMissing = true;
					log.warn(
						'linctl binary not found on PATH — Linear comment posting disabled.',
					);
					return false;
				}

				lastError = err;
				if (attempt < MAX_RETRIES) {
					log.debug(
						`Post comment on ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
					);
					await this.sleepFn(RETRY_DELAY_MS);
				}
			}
		}

		log.warn(
			`Failed to post comment on ${issueKey} after ${MAX_RETRIES} attempts`,
			lastError instanceof Error ? lastError : undefined,
		);
		return false;
	}
}
