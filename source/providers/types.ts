// Provider interfaces for issue trackers and VCS hosts
// These abstractions allow pappardelle to work with Linear/Jira and GitHub/GitLab

/**
 * The trackers pappardelle can talk to. Declared once here rather than as an
 * inline union at each use: key grammar, list layout and claim support all
 * branch on it, and a `string` parameter at any of those lets a typo through to
 * a silent fallback.
 */
export type TrackerProviderName = 'linear' | 'jira' | 'beads';

export type VcsProviderName = 'github' | 'gitlab';

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
		/**
		 * Jira project key (e.g. "KAN"). Linear projects have no key. Carried so
		 * profile resolution can match `tracker_projects` entries written as
		 * either the display name or the key (STA-1649).
		 */
		key?: string;
	} | null;
	labels?: string[]; // Label names (e.g., ["bug", "feature"])
	// Canonical web URL as returned by the issue tracker — preferred over any
	// reconstruction because it embeds the correct workspace slug (Linear) and
	// the actual issue slug suffix.
	url?: string;
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
	readonly name: TrackerProviderName;

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

	/**
	 * Show the issue to the user in place, for trackers whose issues have no
	 * web page (beads is local-only). Providers that can produce a URL leave
	 * this undefined and the caller falls back to `buildIssueUrl` + `open`.
	 * Returns false when the issue could not be displayed.
	 */
	openIssue?(issueKey: string): boolean;

	/** Post a comment on an issue */
	createComment(issueKey: string, body: string): Promise<boolean>;

	/** Search for issues assigned to a user with matching statuses */
	searchAssignedIssues(
		assignee: string | undefined,
		statuses: string[],
	): Promise<TrackerIssue[]>;

	/**
	 * Unblocked, unstarted work the user could pick up right now, offered as
	 * suggestions in the new-session prompt. Only trackers that can answer this
	 * cheaply and locally implement it — a remote round-trip on every keystroke-
	 * free dialog open is not worth the latency — so callers must treat an
	 * undefined method as "no suggestions" rather than an error.
	 */
	listReadyIssues?(): Promise<TrackerIssue[]>;

	/**
	 * Mark an issue done from inside the TUI. Only trackers whose "close" is a
	 * single local, unambiguous transition implement it — remote trackers model
	 * completion as a workflow state whose name varies per project, so there is
	 * no safe default to pick on the user's behalf.
	 */
	closeIssue?(issueKey: string): Promise<boolean>;

	/**
	 * Take ownership of an issue and move it out of the ready pool, called as a
	 * workspace starts building. Without it a ready-work suggestion stays ready
	 * for the whole of setup, so opening several workspaces back to back keeps
	 * re-offering the ones already in flight.
	 *
	 * Same restraint as closeIssue: only trackers with a single unambiguous
	 * local transition implement it. Advisory — a false return means the issue
	 * keeps showing up, never that workspace creation should stop.
	 */
	claimIssue?(issueKey: string): Promise<boolean>;
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
