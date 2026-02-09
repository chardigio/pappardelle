// Provider interfaces for issue trackers and VCS hosts
// These abstractions allow pappardelle to work with Linear/Jira and GitHub/GitLab

/**
 * Provider-agnostic issue representation.
 * Maps to LinearIssue shape for backwards compatibility.
 */
export interface TrackerIssue {
	identifier: string; // e.g., "STA-123" or "PROJ-456"
	title: string;
	state: {
		name: string;
		type: string;
		color: string;
	};
	project?: {
		name: string;
	} | null;
}

/**
 * Result of checking if an issue has an associated PR/MR with actual changes.
 */
export interface PRInfo {
	hasPR: boolean;
	hasCommits: boolean;
	prNumber?: number;
	prUrl?: string;
}

/**
 * Issue tracker provider interface (Linear, Jira, etc.)
 */
export interface IssueTrackerProvider {
	readonly name: string;

	/** Fetch an issue by key, with caching */
	getIssue(issueKey: string): Promise<TrackerIssue | null>;

	/** Get a cached issue (no fetch) */
	getIssueCached(issueKey: string): TrackerIssue | null;

	/** Look up a workflow state color by state name */
	getWorkflowStateColor(stateName: string): string | null;

	/** Clear all caches */
	clearCache(): void;

	/** Build the web URL for an issue */
	buildIssueUrl(issueKey: string): string;

	/** Post a comment on an issue */
	createComment(issueKey: string, body: string): Promise<boolean>;
}

/**
 * VCS host provider interface (GitHub, GitLab, etc.)
 */
export interface VcsHostProvider {
	readonly name: string;

	/** Check if an issue has a PR/MR with actual file changes */
	checkIssueHasPRWithCommits(issueKey: string): PRInfo;

	/** Build the web URL for a PR/MR */
	buildPRUrl(prNumber: number): string;
}
