// Types for Pappardelle TUI

// Brand colors
export const COLORS = {
	CLAUDE_ORANGE: '#DE7356',
} as const;

import type {TrackerIssue} from './providers/types.ts';

/**
 * Provider-agnostic issue type. Identical to TrackerIssue.
 * @deprecated Use TrackerIssue from providers/types for new code.
 */
export type LinearIssue = TrackerIssue;

export type {TrackerIssue} from './providers/types.ts';

export type ClaudeStatus =
	| 'processing'
	| 'running_tool'
	| 'waiting_for_input'
	| 'waiting_for_approval'
	| 'compacting'
	| 'ended'
	| 'error'
	| 'unknown';

export interface ClaudeSessionState {
	sessionId: string;
	workspaceName: string;
	status: ClaudeStatus;
	lastUpdate: number;
	currentTool?: string;
	event?: string;
	cwd?: string;
}

/**
 * SpaceData represents a DOW workspace (Linear issue with worktree)
 */
export interface SpaceData {
	name: string; // Issue key (e.g., STA-123) or branch name for main worktree
	statusKey?: string; // Repo-qualified key for status file lookups (e.g., "pappa-chex-main"); defaults to name
	linearIssue?: LinearIssue;
	/** Provider-agnostic alias for linearIssue. Prefer this in new code. */
	trackerIssue?: TrackerIssue;
	claudeStatus?: ClaudeStatus;
	claudeTool?: string; // Current tool name (for UI differentiation, e.g. AskUserQuestion)
	worktreePath: string | null;
	isMainWorktree?: boolean; // True for the main (master/main) worktree — cannot be deleted
	isDirty?: boolean; // True if worktree has uncommitted changes (used for main worktree color)
	isPending?: boolean; // True for placeholder rows shown while a new session is starting
	pendingTitle?: string; // Title text for pending rows (e.g., "Resuming..." or "Starting new session...")
}

/**
 * Pane layout configuration for the main pappardelle window
 */
export interface PaneLayout {
	listPaneId: string;
	claudeViewerPaneId: string; // Viewer pane that attaches to claude-STA-XXX session
	lazygitViewerPaneId: string; // Viewer pane that attaches to lazygit-STA-XXX session
}

// Statuses that are stable and should never become stale
export const STABLE_STATUSES = new Set<ClaudeStatus>([
	'waiting_for_input', // Waiting for user input - user may take time to respond
	'waiting_for_approval', // Waiting for permission - user may be reviewing
	'ended', // Session terminated - stays ended
	'error', // Error state should persist until resolved
]);

// Statuses that indicate active work and can become stale
export const ACTIVE_STATUSES = new Set<ClaudeStatus>([
	'processing',
	'running_tool',
	'compacting',
]);

// How long before an active status becomes stale (10 minutes)
export const ACTIVE_STATUS_TIMEOUT = 10 * 60 * 1000;

// Claude status display
// Note: "processing" and "running_tool" use ClaudeAnimation instead of a static icon
export const CLAUDE_STATUS_DISPLAY: Record<
	ClaudeStatus,
	{color: string; icon?: string}
> = {
	processing: {color: COLORS.CLAUDE_ORANGE},
	running_tool: {color: COLORS.CLAUDE_ORANGE},
	waiting_for_input: {color: 'green', icon: '●'},
	waiting_for_approval: {color: 'red', icon: '!'},
	compacting: {color: 'yellow', icon: '◇'},
	ended: {color: 'green', icon: '●'},
	error: {color: 'red', icon: '✗'},
	unknown: {color: 'gray', icon: '?'},
};
