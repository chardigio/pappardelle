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
	| 'idle'
	| 'thinking'
	| 'tool_use'
	| 'waiting_input'
	| 'waiting_permission'
	| 'done'
	| 'error'
	| 'unknown';

export interface ClaudeSessionState {
	sessionId: string;
	workspaceName: string;
	status: ClaudeStatus;
	lastUpdate: number;
	currentTool?: string;
}

/**
 * SpaceData represents a DOW workspace (Linear issue with worktree)
 */
export interface SpaceData {
	name: string; // Issue key (e.g., STA-123)
	linearIssue?: LinearIssue;
	claudeStatus?: ClaudeStatus;
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
// Note: "thinking" and "tool_use" use ClaudeAnimation instead of a static icon
export const CLAUDE_STATUS_DISPLAY: Record<
	ClaudeStatus,
	{color: string; icon?: string}
> = {
	idle: {color: 'gray', icon: '○'},
	thinking: {color: COLORS.CLAUDE_ORANGE},
	tool_use: {color: COLORS.CLAUDE_ORANGE},
	waiting_input: {color: 'blue', icon: '?'},
	waiting_permission: {color: 'red', icon: '!'},
	done: {color: 'green', icon: '✓'},
	error: {color: 'red', icon: '✗'},
	unknown: {color: 'gray', icon: '?'},
};
