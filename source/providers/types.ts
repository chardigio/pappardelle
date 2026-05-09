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
	labels?: string[]; // Label names (e.g., ["bug", "feature"])
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
 * Coarse-grained CI/CD pipeline state for the rail icon column.
 * - passing: all checks completed successfully
 * - failing: all checks completed, at least one non-success
 * - progressing_clean: one or more checks still running, nothing failed yet
 * - progressing_dirty: one or more checks still running, at least one already failed
 */
export type PipelineStatus =
	| 'passing'
	| 'failing'
	| 'progressing_clean'
	| 'progressing_dirty';

/**
 * Per-row data fetched from the VCS host for the ticket rail's status column.
 * `pipeline` is `null` when the branch has no open PR/MR (or when fetching
 * failed); in that case the rail should hide both the pipeline icon and the
 * comment icon even if `unresolvedCommentCount` is non-zero.
 *
 * `hasConflict` is true only when the host reports the PR/MR as un-mergeable
 * due to conflicts (GitHub `mergeable: CONFLICTING`). `UNKNOWN` (still
 * computing) is treated as false to avoid flicker on every fresh PR.
 */
export interface RailStatus {
	pipeline: PipelineStatus | null;
	unresolvedCommentCount: number;
	prNumber?: number;
	hasConflict?: boolean;
}

/**
 * Issue tracker provider interface (Linear, Jira, etc.)
 */
export interface IssueTrackerProvider {
	readonly name: string;

	/** Fetch an issue by key, with caching */
	getIssue(issueKey: string): Promise<TrackerIssue | null>;

	/** Fetch multiple issues in a single batch (one CLI call where possible). */
	getIssues(issueKeys: string[]): Promise<Map<string, TrackerIssue | null>>;

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

	/** Search for issues assigned to a user with matching statuses */
	searchAssignedIssues(
		assignee: string | undefined,
		statuses: string[],
	): Promise<TrackerIssue[]>;
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

	/**
	 * Fetch the rail-status snapshot for an issue's branch:
	 * pipeline state + unresolved PR/MR comment count. Implementations
	 * should be resilient to "no PR", "no checks", or transient CLI
	 * failures and return `{pipeline: null, unresolvedCommentCount: 0}`
	 * in those cases.
	 */
	getRailStatus(issueKey: string): Promise<RailStatus>;

	/**
	 * Fetch rail-status for multiple issues in a single API call.
	 * Returns a Map from issue key → RailStatus. Keys with no open PR
	 * map to `{pipeline: null, unresolvedCommentCount: 0}`. On total
	 * failure (e.g. rate-limited), returns an empty Map so callers
	 * can preserve existing state.
	 */
	getBulkRailStatus(issueKeys: string[]): Promise<Map<string, RailStatus>>;
}
