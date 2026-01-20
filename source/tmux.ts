// Tmux session management for SSH mode
import {execSync, spawnSync} from 'node:child_process';

export interface TmuxSession {
	name: string;
	windows: number;
	attached: boolean;
	created: Date;
}

/**
 * Check if we're running in an SSH session
 */
export function isSSH(): boolean {
	return Boolean(process.env['SSH_CONNECTION']);
}

/**
 * List all tmux sessions
 */
export function listTmuxSessions(): TmuxSession[] {
	try {
		const output = execSync(
			'tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}"',
			{encoding: 'utf-8', timeout: 5000},
		);

		return output
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [name, windows, attached, created] = line.split('|');
				return {
					name: name ?? '',
					windows: parseInt(windows ?? '0', 10),
					attached: attached === '1',
					created: new Date(parseInt(created ?? '0', 10) * 1000),
				};
			});
	} catch {
		return [];
	}
}

/**
 * List Claude Code tmux sessions (matching claude-STA-* pattern)
 */
export function listClaudeSessions(): TmuxSession[] {
	return listTmuxSessions().filter((session) =>
		/^claude-STA-\d+$/.test(session.name),
	);
}

/**
 * Get the issue key from a Claude session name
 */
export function getIssueKeyFromSession(sessionName: string): string | null {
	const match = sessionName.match(/^claude-(STA-\d+)$/);
	return match ? match[1] ?? null : null;
}

/**
 * Switch to a tmux session (attach if not already attached)
 */
export function switchToTmuxSession(sessionName: string): boolean {
	try {
		// If we're in tmux, switch client. Otherwise, print instructions.
		if (process.env['TMUX']) {
			execSync(`tmux switch-client -t "${sessionName}"`, {
				encoding: 'utf-8',
				timeout: 5000,
			});
		} else {
			// Can't attach from non-tmux context in this app
			// Return false to indicate user needs to attach manually
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a new tmux session for a DOW workspace
 */
export function createTmuxSession(
	issueKey: string,
	workingDir: string,
): boolean {
	const sessionName = `claude-${issueKey}`;
	try {
		// Create detached session
		spawnSync(
			'tmux',
			['new-session', '-d', '-s', sessionName, '-c', workingDir],
			{encoding: 'utf-8', timeout: 10000},
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(sessionName: string): boolean {
	try {
		execSync(`tmux has-session -t "${sessionName}"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}
