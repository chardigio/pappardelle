// Jira issue tracker provider — wraps acli (Atlassian CLI)
import {execFileSync} from 'node:child_process';
import {createLogger} from '../logger.ts';
import type {IssueTrackerProvider, TrackerIssue} from './types.ts';

const log = createLogger('jira-provider');
const CACHE_TTL_MS = 60_000;

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

function mapJiraIssue(raw: Record<string, unknown>): TrackerIssue {
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

export class JiraProvider implements IssueTrackerProvider {
	readonly name = 'jira';
	private readonly baseUrl: string;
	private readonly issueCache = new Map<string, CacheEntry>();
	private readonly stateColorMap = new Map<string, string>();

	constructor(baseUrl: string) {
		// Strip trailing slash
		this.baseUrl = baseUrl.replace(/\/+$/, '');
	}

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
			log.warn(
				`Failed to fetch Jira issue ${issueKey}`,
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
		return this.stateColorMap.get(stateName) ?? null;
	}

	clearCache(): void {
		this.issueCache.clear();
	}

	buildIssueUrl(issueKey: string): string {
		return `${this.baseUrl}/browse/${issueKey}`;
	}

	async createComment(issueKey: string, body: string): Promise<boolean> {
		try {
			execFileSync(
				'acli',
				['jira', 'workitem', 'comment', '--key', issueKey, '--body', body],
				{encoding: 'utf-8', timeout: 30_000},
			);
			return true;
		} catch (err) {
			log.warn(
				`Failed to post comment on Jira issue ${issueKey}`,
				err instanceof Error ? err : undefined,
			);
			return false;
		}
	}
}
