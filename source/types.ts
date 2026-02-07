// Types for Pappardelle TUI

// Brand colors
export const COLORS = {
	CLAUDE_ORANGE: '#DE7356',
} as const;

export interface LinearIssue {
	identifier: string;
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
	name: string; // Issue key (e.g., STA-123)
	linearIssue?: LinearIssue;
	claudeStatus?: ClaudeStatus;
	claudeTool?: string; // Current tool name (for UI differentiation, e.g. AskUserQuestion)
	worktreePath: string | null;
}

/**
 * Pane layout configuration for the main pappardelle window
 */
export interface PaneLayout {
	listPaneId: string;
	claudeViewerPaneId: string; // Viewer pane that attaches to claude-STA-XXX session
	lazygitViewerPaneId: string; // Viewer pane that attaches to lazygit-STA-XXX session
}

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
