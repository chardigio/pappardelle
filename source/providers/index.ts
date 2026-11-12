// Provider factory — creates and caches provider singletons
import {BeadsProvider} from './beads-provider.ts';
import {GitHubProvider} from './github-provider.ts';
import {GitLabProvider} from './gitlab-provider.ts';
import {JiraProvider} from './jira-provider.ts';
import {createDefaultLinearGraphQLClient} from './linear-graphql.ts';
import {LinearProvider} from './linear-provider.ts';
import type {PrLinkStampDao} from '../pr-link-stamp.ts';
import {StateColorCache, type StateColorDao} from './state-color-cache.ts';
import type {
	IssueTrackerProvider,
	TrackerProviderName,
	VcsHostProvider,
	VcsProviderName,
} from './types.ts';
import type {RepositoryDiscovery} from './workspace-repositories.ts';

export type {
	TrackerIssue,
	PRInfo,
	PRLink,
	PipelineStatus,
	RailStatus,
	IssueTrackerProvider,
	TrackerProviderName,
	VcsHostProvider,
	VcsProviderName,
} from './types.ts';

export interface IssueTrackerConfig {
	provider: TrackerProviderName;
	base_url?: string; // Required for Jira
}

export interface VcsHostConfig {
	provider: VcsProviderName;
	host?: string; // For self-hosted GitLab
}

let issueTrackerInstance: IssueTrackerProvider | null = null;
let issueTrackerConfigKey: string | null = null;
let vcsHostInstance: VcsHostProvider | null = null;
let vcsHostConfigKey: string | null = null;
let workspaceDiscovery: RepositoryDiscovery | undefined;
let stateColors: StateColorDao | undefined;
let prLinkStamp: PrLinkStampDao | undefined;

/**
 * How the VCS host finds the repositories in a workspace. The host is built
 * on first use, wherever that is, so startup hands this over beforehand: it
 * is what makes the rail follow a branch recorded by link-pr.
 */
export function setWorkspaceDiscovery(discover: RepositoryDiscovery): void {
	workspaceDiscovery = discover;
}

/**
 * Where the issue tracker keeps workflow state colors between runs. Like the
 * discovery above, startup hands it over before the tracker is first built.
 * Without it a tracker remembers colors only while the process lives.
 */
export function setStateColors(dao: StateColorDao): void {
	stateColors = dao;
}

/**
 * Where `pappardelle link-pr` records that a PR was just linked, which ends
 * GitHub's failure backoff early. Handed over at startup like the two above.
 * Without it a failed lookup waits out its backoff.
 */
export function setPrLinkStamp(dao: PrLinkStampDao): void {
	prLinkStamp = dao;
}

function trackerKey(config?: IssueTrackerConfig): string {
	const provider = config?.provider ?? 'linear';
	if (provider === 'jira') return `jira:${config?.base_url ?? ''}`;
	if (provider === 'beads') return 'beads';
	return 'linear';
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
			issueTrackerInstance = new LinearProvider(
				undefined,
				undefined,
				new StateColorCache(stateColors),
				createDefaultLinearGraphQLClient(),
			);
			break;
		}

		case 'jira': {
			if (!config?.base_url) {
				throw new Error(
					'issue_tracker.base_url is required when provider is "jira"',
				);
			}

			issueTrackerInstance = new JiraProvider(
				config.base_url,
				undefined,
				undefined,
				new StateColorCache(stateColors),
			);
			break;
		}

		case 'beads': {
			issueTrackerInstance = new BeadsProvider(
				undefined,
				undefined,
				new StateColorCache(stateColors),
			);
			break;
		}

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
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
			const stamp = prLinkStamp;
			vcsHostInstance = new GitHubProvider(
				undefined,
				undefined,
				workspaceDiscovery,
				stamp ? {linkedAt: () => stamp.read()} : {},
			);
			break;
		}

		case 'gitlab': {
			vcsHostInstance = new GitLabProvider(
				config?.host,
				undefined,
				undefined,
				workspaceDiscovery,
			);
			break;
		}

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
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
	workspaceDiscovery = undefined;
	stateColors = undefined;
	prLinkStamp = undefined;
}
