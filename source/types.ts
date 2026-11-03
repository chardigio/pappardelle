// Types for Pappardelle TUI

// Brand colors
export const COLORS = {
	CLAUDE_ORANGE: '#DE7356',
} as const;

import type {RailStatus, TrackerIssue} from './providers/types.ts';

/**
 * Provider-agnostic issue type. Identical to TrackerIssue.
 * @deprecated Use TrackerIssue from providers/types for new code.
 */
export type LinearIssue = TrackerIssue;

export type {
	PipelineStatus,
	RailStatus,
	TrackerIssue,
} from './providers/types.ts';

import type {ProgramStatusInfo} from './program-status.ts';
/**
 * SpaceData represents a DOW workspace (Linear issue with worktree)
 */
export interface SpaceData {
	name: string; // Issue key (e.g., STA-123) or branch name for main worktree
	statusKey?: string; // Repo-qualified key for status file lookups (e.g., "pappa-chex-main"); defaults to name
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	linearIssue?: LinearIssue;
	/** Provider-agnostic alias for linearIssue. Prefer this in new code. */
	trackerIssue?: TrackerIssue;
	programStatus?: ProgramStatusInfo;
	worktreePath: string | null;
	isMainWorktree?: boolean; // True for the main (master/main) worktree — cannot be deleted
	isDirty?: boolean; // True if worktree has uncommitted changes (used for main worktree color)
	isPending?: boolean; // True for placeholder rows shown while a new session is starting
	pendingTitle?: string; // Title text for pending rows (e.g., "Opening..." or "Starting new session...")
	railStatus?: RailStatus; // Snapshot of PR pipeline state + unresolved comment count (from VcsHostProvider.getRailStatus)
	profileEmoji?: string; // Optional emoji for the active profile, rendered to the left of the Claude status icon
}

/**
 * Pane layout configuration for the main pappardelle window
 */
export interface PaneLayout {
	listPaneId: string;
	agentViewerPaneId: string; // Viewer pane that attaches to agent-STA-XXX session
	companionViewerPaneId: string; // Viewer pane that attaches to companion-STA-XXX session
}
