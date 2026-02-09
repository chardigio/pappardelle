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

	async getIssue(issueKey: string): Promise<TrackerIssue | null> {
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
			log.warn(
				`Failed to fetch issue ${issueKey}`,
				err instanceof Error ? err : undefined,
			);
			this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
			return null;
		}
	}

	getIssueCached(issueKey: string): TrackerIssue | null {
		return this.issueCache.get(issueKey)?.issue ?? null;
	}

	getWorkflowStateColor(stateName: string): string | null {
		const cached = this.stateColorMap.get(stateName);
		if (cached) return cached;

		try {
			const output = execFileSync(
				'linctl',
				['issue', 'list', '--state', stateName, '--limit', '1', '--json'],
				{encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe']},
			);
			const issues = JSON.parse(output) as TrackerIssue[];
			if (issues.length > 0 && issues[0]!.state.color) {
				this.stateColorMap.set(stateName, issues[0]!.state.color);
				return issues[0]!.state.color;
			}
		} catch {
			log.warn(`Failed to fetch workflow state color for "${stateName}"`);
		}

		return null;
	}

	clearCache(): void {
		this.issueCache.clear();
	}

	buildIssueUrl(issueKey: string): string {
		return `https://linear.app/stardust-labs/issue/${issueKey}`;
	}

	async createComment(issueKey: string, body: string): Promise<boolean> {
		try {
			execFileSync('linctl', ['comment', 'create', issueKey, '--body', body], {
				encoding: 'utf-8',
				timeout: 30_000,
			});
			return true;
		} catch (err) {
			log.warn(
				`Failed to post comment on ${issueKey}`,
				err instanceof Error ? err : undefined,
			);
			return false;
		}
	}
}
