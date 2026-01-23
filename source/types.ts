// Types for Pappardelle TUI

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
	claudeViewerPaneId: string;  // Viewer pane that attaches to claude-STA-XXX session
	lazygitViewerPaneId: string; // Viewer pane that attaches to lazygit-STA-XXX session
}

// Claude status display
// Note: "thinking" and "tool_use" both show as "Working" to avoid distracting flicker
// when Claude rapidly switches between thinking and using tools
export const CLAUDE_STATUS_DISPLAY: Record<
	ClaudeStatus,
	{label: string; color: string; icon: string}
> = {
	idle: {label: 'Idle', color: 'gray', icon: '○'},
	thinking: {label: 'Working', color: 'blue', icon: '◐'},
	tool_use: {label: 'Working', color: 'blue', icon: '◐'},
	waiting_input: {label: 'Waiting', color: 'magenta', icon: '?'},
	waiting_permission: {label: 'Permission', color: 'red', icon: '!'},
	done: {label: 'Done', color: 'green', icon: '✓'},
	error: {label: 'Error', color: 'red', icon: '✗'},
	unknown: {label: 'Unknown', color: 'gray', icon: '?'},
};
