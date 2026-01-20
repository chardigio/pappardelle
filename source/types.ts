// Types for Pappardelle TUI

export interface AerospaceWorkspace {
	workspace: string;
}

export interface AerospaceWindow {
	'app-name': string;
	'window-id': number;
	'window-title': string;
}

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

export interface WorkspaceData {
	name: string;
	isLinearIssue: boolean;
	linearIssue?: LinearIssue;
	windows: AerospaceWindow[];
	claudeStatus?: ClaudeStatus;
	isVisible: boolean;
	tmuxSession?: string; // For SSH mode: the tmux session name
}

// Generate app icon from first 2 letters of app name
export function getAppIcon(appName: string): string {
	if (!appName || appName.length === 0) {
		return '??';
	}
	return appName.slice(0, 2);
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
