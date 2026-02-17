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
let issueTrackerConfigKey: string | null = null;
let vcsHostInstance: VcsHostProvider | null = null;
let vcsHostConfigKey: string | null = null;

function trackerKey(config?: IssueTrackerConfig): string {
	const provider = config?.provider ?? 'linear';
	return provider === 'jira' ? `jira:${config?.base_url ?? ''}` : 'linear';
}

function vcsKey(config?: VcsHostConfig): string {
	const provider = config?.provider ?? 'github';
	return provider === 'gitlab' ? `gitlab:${config?.host ?? ''}` : 'github';
}

/**
 * Create (or return cached) issue tracker provider.
 * When called without config, returns the existing singleton if one was
 * already initialized (regardless of provider type). Only defaults to
 * Linear when no singleton exists and no config is provided.
 * Throws if called with an explicit config that differs from the cached instance.
 */
export function createIssueTracker(
	config?: IssueTrackerConfig,
): IssueTrackerProvider {
	// No config: return existing singleton without key checking
	if (!config && issueTrackerInstance) {
		return issueTrackerInstance;
	}

	const key = trackerKey(config);

	if (issueTrackerInstance) {
		if (issueTrackerConfigKey !== key) {
			throw new Error(
				`Issue tracker already initialized as "${issueTrackerConfigKey}" — cannot re-initialize as "${key}". Call resetProviders() first.`,
			);
		}

		return issueTrackerInstance;
	}

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

	issueTrackerConfigKey = key;
	return issueTrackerInstance;
}

/**
 * Create (or return cached) VCS host provider.
 * When called without config, returns the existing singleton if one was
 * already initialized. Only defaults to GitHub when no singleton exists
 * and no config is provided.
 * Throws if called with an explicit config that differs from the cached instance.
 */
export function createVcsHost(config?: VcsHostConfig): VcsHostProvider {
	// No config: return existing singleton without key checking
	if (!config && vcsHostInstance) {
		return vcsHostInstance;
	}

	const key = vcsKey(config);

	if (vcsHostInstance) {
		if (vcsHostConfigKey !== key) {
			throw new Error(
				`VCS host already initialized as "${vcsHostConfigKey}" — cannot re-initialize as "${key}". Call resetProviders() first.`,
			);
		}

		return vcsHostInstance;
	}

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

	vcsHostConfigKey = key;
	return vcsHostInstance;
}

/**
 * Reset all cached provider instances (useful for tests).
 */
export function resetProviders(): void {
	issueTrackerInstance = null;
	issueTrackerConfigKey = null;
	vcsHostInstance = null;
	vcsHostConfigKey = null;
}
