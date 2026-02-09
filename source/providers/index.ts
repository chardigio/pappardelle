// Provider factory — creates and caches provider singletons
import {GitHubProvider} from './github-provider.ts';
import {GitLabProvider} from './gitlab-provider.ts';
import {JiraProvider} from './jira-provider.ts';
import {LinearProvider} from './linear-provider.ts';
import type {IssueTrackerProvider, VcsHostProvider} from './types.ts';

export type {
	TrackerIssue,
	PRInfo,
	IssueTrackerProvider,
	VcsHostProvider,
} from './types.ts';

export interface IssueTrackerConfig {
	provider: 'linear' | 'jira';
	base_url?: string; // Required for Jira
}

export interface VcsHostConfig {
	provider: 'github' | 'gitlab';
	host?: string; // For self-hosted GitLab
}

let issueTrackerInstance: IssueTrackerProvider | null = null;
let vcsHostInstance: VcsHostProvider | null = null;

/**
 * Create (or return cached) issue tracker provider.
 * Defaults to Linear when no config is provided.
 */
export function createIssueTracker(
	config?: IssueTrackerConfig,
): IssueTrackerProvider {
	if (issueTrackerInstance) return issueTrackerInstance;

	const provider = config?.provider ?? 'linear';

	switch (provider) {
		case 'linear': {
			issueTrackerInstance = new LinearProvider();
			break;
		}

		case 'jira': {
			if (!config?.base_url) {
				throw new Error(
					'issue_tracker.base_url is required when provider is "jira"',
				);
			}

			issueTrackerInstance = new JiraProvider(config.base_url);
			break;
		}

		default: {
			throw new Error(
				`Unknown issue tracker provider: "${provider as string}"`,
			);
		}
	}

	return issueTrackerInstance;
}

/**
 * Create (or return cached) VCS host provider.
 * Defaults to GitHub when no config is provided.
 */
export function createVcsHost(config?: VcsHostConfig): VcsHostProvider {
	if (vcsHostInstance) return vcsHostInstance;

	const provider = config?.provider ?? 'github';

	switch (provider) {
		case 'github': {
			vcsHostInstance = new GitHubProvider();
			break;
		}

		case 'gitlab': {
			vcsHostInstance = new GitLabProvider(config?.host);
			break;
		}

		default: {
			throw new Error(`Unknown VCS host provider: "${provider as string}"`);
		}
	}

	return vcsHostInstance;
}

/**
 * Reset all cached provider instances (useful for tests).
 */
export function resetProviders(): void {
	issueTrackerInstance = null;
	vcsHostInstance = null;
}
