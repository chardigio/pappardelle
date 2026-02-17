// Linear issue tracker provider — wraps linctl CLI
import {execFileSync} from 'node:child_process';
import {createLogger} from '../logger.ts';
import type {IssueTrackerProvider, TrackerIssue} from './types.ts';

const log = createLogger('linear-provider');
const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
	issue: TrackerIssue | null;
	timestamp: number;
}

export class LinearProvider implements IssueTrackerProvider {
	readonly name = 'linear';
	private readonly issueCache = new Map<string, CacheEntry>();
	private readonly stateColorMap = new Map<string, string>();
	private linctlMissing = false;

	async getIssue(issueKey: string): Promise<TrackerIssue | null> {
		if (this.linctlMissing) {
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

		try {
			const output = execFileSync(
				'linctl',
				['issue', 'get', issueKey, '--json'],
				{encoding: 'utf-8', timeout: 10_000},
			);
			const issue = JSON.parse(output) as TrackerIssue;
			this.issueCache.set(issueKey, {issue, timestamp: Date.now()});
			this.stateColorMap.set(issue.state.name, issue.state.color);
			log.debug(`Fetched issue ${issueKey}: ${issue.title}`);
			return issue;
		} catch (err) {
			const isEnoent =
				err instanceof Error &&
				'code' in err &&
				(err as NodeJS.ErrnoException).code === 'ENOENT';
			if (isEnoent) {
				this.linctlMissing = true;
				log.warn(
					'linctl binary not found on PATH — Linear issue fetching disabled. Install linctl or check your PATH.',
				);
			} else {
				log.warn(
					`Failed to fetch issue ${issueKey}`,
					err instanceof Error ? err : undefined,
				);
			}

			this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
			return null;
		}
	}

	getIssueCached(issueKey: string): TrackerIssue | null {
		return this.issueCache.get(issueKey)?.issue ?? null;
	}

	getWorkflowStateColor(stateName: string): string | null {
		return this.stateColorMap.get(stateName) ?? null;
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

		try {
			execFileSync('linctl', ['comment', 'create', issueKey, '--body', body], {
				encoding: 'utf-8',
				timeout: 30_000,
			});
			return true;
		} catch (err) {
			const isEnoent =
				err instanceof Error &&
				'code' in err &&
				(err as NodeJS.ErrnoException).code === 'ENOENT';
			if (isEnoent) {
				this.linctlMissing = true;
				log.warn(
					'linctl binary not found on PATH — Linear comment posting disabled.',
				);
			} else {
				log.warn(
					`Failed to post comment on ${issueKey}`,
					err instanceof Error ? err : undefined,
				);
			}

			return false;
		}
	}
}
