// Tmux session attachment for pappardelle
// Attaches to existing claude-STA-XXX and lazygit-STA-XXX sessions created by idow
import {execSync, spawnSync} from 'node:child_process';
import {createLogger} from './logger.js';

const log = createLogger('tmux');

// Session naming convention (matches idow)
export const CLAUDE_SESSION_PREFIX = 'claude-';
export const LAZYGIT_SESSION_PREFIX = 'lazygit-';

// Track which space is currently being viewed
let currentlyViewingSpace: string | null = null;

// Track if panes have active tmux sessions (vs just shell)
let claudeViewerHasSession = false;
let lazygitViewerHasSession = false;

/**
 * Check if running inside tmux
 */
export function isInTmux(): boolean {
	return Boolean(process.env['TMUX']);
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(sessionName: string): boolean {
	try {
		execSync(`tmux has-session -t "${sessionName}"`, {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Get session names for a space
 */
export function getSessionNames(issueKey: string): {
	claude: string;
	lazygit: string;
} {
	return {
		claude: `${CLAUDE_SESSION_PREFIX}${issueKey}`,
		lazygit: `${LAZYGIT_SESSION_PREFIX}${issueKey}`,
	};
}

/**
 * Check if sessions exist for a space (created by idow)
 */
export function spaceHasSessions(issueKey: string): {
	claude: boolean;
	lazygit: boolean;
} {
	const names = getSessionNames(issueKey);
	return {
		claude: sessionExists(names.claude),
		lazygit: sessionExists(names.lazygit),
	};
}

/**
 * List all claude sessions (claude-STA-*)
 */
export function listClaudeSessions(): string[] {
	try {
		const output = execSync('tmux list-sessions -F "#{session_name}"', {
			encoding: 'utf-8',
			timeout: 5000,
		});

		return output
			.trim()
			.split('\n')
			.filter(name => name.startsWith(CLAUDE_SESSION_PREFIX));
	} catch {
		return [];
	}
}

/**
 * Send keys to a pane (for attaching to sessions)
 * Clears any partial input first to avoid leftover characters
 */
function sendToPane(paneId: string, command: string): boolean {
	try {
		// Clear any partial input on the line first (Ctrl+U)
		spawnSync('tmux', ['send-keys', '-t', paneId, 'C-u'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		// Now send the actual command
		spawnSync('tmux', ['send-keys', '-t', paneId, command, 'Enter'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch (err) {
		log.error(
			`Failed to send command to pane ${paneId}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Send Ctrl+C to interrupt any running process in a pane
 */
function interruptPane(paneId: string): void {
	try {
		spawnSync('tmux', ['send-keys', '-t', paneId, 'C-c'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
	} catch {
		// Ignore errors
	}
}

/**
 * Detach from any tmux session running in a pane
 * This sends the detach command (prefix + d) to the nested tmux
 */
function detachInPane(paneId: string): void {
	try {
		// Send Ctrl+B then d (tmux detach) - works for nested tmux
		spawnSync('tmux', ['send-keys', '-t', paneId, 'C-b', 'd'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
	} catch {
		// Ignore errors
	}
}

/**
 * Set up the initial 3-pane layout for pappardelle
 * Returns pane IDs for [list, claudeViewer, lazygitViewer]
 */
export function setupPappardellLayout(): {
	listPaneId: string;
	claudeViewerPaneId: string;
	lazygitViewerPaneId: string;
} | null {
	try {
		// Get current pane from TMUX_PANE env var
		const listPaneId = process.env['TMUX_PANE'];
		if (!listPaneId) {
			log.error('TMUX_PANE environment variable not set');
			return null;
		}

		const cwd = process.cwd();

		// Create middle pane (claude viewer) - 76% of remaining width (leaves 24% for list)
		const claudeResult = spawnSync(
			'tmux',
			[
				'split-window',
				'-h',
				'-t',
				listPaneId,
				'-c',
				cwd,
				'-l',
				'76%',
				'-P',
				'-F',
				'#{pane_id}',
			],
			{encoding: 'utf-8', timeout: 10000},
		);

		if (claudeResult.error || claudeResult.status !== 0) {
			log.error(`Failed to create claude viewer pane: ${claudeResult.stderr}`);
			return null;
		}

		const claudeViewerPaneId = claudeResult.stdout.trim();

		// Create right pane (lazygit viewer) - 50% of the 76% (38% each for claude/lazygit)
		const lazygitResult = spawnSync(
			'tmux',
			[
				'split-window',
				'-h',
				'-t',
				claudeViewerPaneId,
				'-c',
				cwd,
				'-l',
				'50%',
				'-P',
				'-F',
				'#{pane_id}',
			],
			{encoding: 'utf-8', timeout: 10000},
		);

		if (lazygitResult.error || lazygitResult.status !== 0) {
			log.error(`Failed to create lazygit viewer pane: ${lazygitResult.stderr}`);
			return null;
		}

		const lazygitViewerPaneId = lazygitResult.stdout.trim();

		// Set pane titles
		execSync(`tmux select-pane -t "${listPaneId}" -T "pappardelle"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		execSync(`tmux select-pane -t "${claudeViewerPaneId}" -T "claude-viewer"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		execSync(`tmux select-pane -t "${lazygitViewerPaneId}" -T "lazygit-viewer"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});

		// Return focus to list pane
		execSync(`tmux select-pane -t "${listPaneId}"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});

		log.info(
			`Set up pappardelle layout: list=${listPaneId}, claude=${claudeViewerPaneId}, lazygit=${lazygitViewerPaneId}`,
		);

		return {listPaneId, claudeViewerPaneId, lazygitViewerPaneId};
	} catch (err) {
		log.error(
			'Failed to set up pappardelle layout',
			err instanceof Error ? err : undefined,
		);
		return null;
	}
}

/**
 * Attach viewer panes to a space's sessions
 * This detaches from current sessions (if any) and attaches to the new space's sessions
 */
export function attachToSpace(
	claudeViewerPaneId: string,
	lazygitViewerPaneId: string,
	issueKey: string,
	listPaneId?: string,
): boolean {
	// If already viewing this space, nothing to do
	if (currentlyViewingSpace === issueKey) {
		return true;
	}

	const sessions = getSessionNames(issueKey);

	// Ensure sessions exist (create if needed)
	ensureClaudeSession(issueKey);
	ensureLazygitSession(issueKey);

	const hasClaudeSession = sessionExists(sessions.claude);
	const hasLazygitSession = sessionExists(sessions.lazygit);

	// Detach from current sessions if they have active nested tmux
	if (currentlyViewingSpace) {
		log.debug(`Detaching from ${currentlyViewingSpace}`);
		if (claudeViewerHasSession) {
			detachInPane(claudeViewerPaneId);
		}
		if (lazygitViewerHasSession) {
			detachInPane(lazygitViewerPaneId);
		}
		// Small delay to let detach complete
		spawnSync('sleep', ['0.1']);
	}

	try {
		// Attach to claude session (or show message if no session)
		// Use TMUX= to allow nested tmux attachment
		if (hasClaudeSession) {
			sendToPane(claudeViewerPaneId, `TMUX= tmux attach -t "${sessions.claude}"`);
			claudeViewerHasSession = true;
			log.info(`Attached claude viewer to ${sessions.claude}`);
		} else {
			sendToPane(claudeViewerPaneId, `clear && echo "No claude session for ${issueKey}"`);
			claudeViewerHasSession = false;
		}

		// Attach to lazygit session (or show message if no session)
		if (hasLazygitSession) {
			sendToPane(lazygitViewerPaneId, `TMUX= tmux attach -t "${sessions.lazygit}"`);
			lazygitViewerHasSession = true;
			log.info(`Attached lazygit viewer to ${sessions.lazygit}`);
		} else {
			sendToPane(lazygitViewerPaneId, `clear && echo "No lazygit session for ${issueKey}"`);
			lazygitViewerHasSession = false;
		}

		// Return focus to the list pane
		if (listPaneId) {
			spawnSync('tmux', ['select-pane', '-t', listPaneId], {
				encoding: 'utf-8',
				timeout: 5000,
			});
		}

		currentlyViewingSpace = issueKey;
		return true;
	} catch (err) {
		log.error(
			`Failed to attach to space ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Display a message in a pane (for empty state)
 */
export function displayMessageInPane(paneId: string, message: string): boolean {
	try {
		interruptPane(paneId);
		if (message) {
			sendToPane(paneId, `echo "${message}"`);
		} else {
			sendToPane(paneId, 'clear');
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the currently viewing space (for state tracking)
 */
export function getCurrentlyViewingSpace(): string | null {
	return currentlyViewingSpace;
}

/**
 * Clear the currently viewing state (e.g., on shutdown)
 */
export function clearCurrentlyViewingSpace(): void {
	currentlyViewingSpace = null;
}

/**
 * Get the worktree path for an issue key
 */
export function getWorktreePath(issueKey: string): string | null {
	try {
		const homeDir = process.env['HOME'] ?? '';
		const worktreePath = `${homeDir}/.worktrees/stardust-labs/${issueKey}`;

		// Verify it exists
		execSync(`test -d "${worktreePath}"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});

		return worktreePath;
	} catch {
		return null;
	}
}

/**
 * Create a claude session for an issue if it doesn't exist
 * Returns true if session exists or was created successfully
 *
 * Creates a shell-based session (not running claude directly) so the session
 * persists even if claude exits.
 */
export function ensureClaudeSession(issueKey: string): boolean {
	const sessionName = `${CLAUDE_SESSION_PREFIX}${issueKey}`;

	// Already exists?
	if (sessionExists(sessionName)) {
		return true;
	}

	// Get worktree path
	const worktreePath = getWorktreePath(issueKey);
	if (!worktreePath) {
		log.warn(`Cannot create claude session for ${issueKey}: no worktree found`);
		return false;
	}

	try {
		// Create detached tmux session with a shell
		const result = spawnSync(
			'tmux',
			['new-session', '-d', '-s', sessionName, '-c', worktreePath],
			{encoding: 'utf-8', timeout: 10000},
		);

		if (result.error || result.status !== 0) {
			log.error(`Failed to create claude session: ${result.stderr}`);
			return false;
		}

		// Now send claude command to the session
		spawnSync(
			'tmux',
			['send-keys', '-t', sessionName, 'claude --dangerously-skip-permissions', 'Enter'],
			{encoding: 'utf-8', timeout: 5000},
		);

		log.info(`Created claude session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to create claude session for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Create a lazygit session for an issue if it doesn't exist
 * Returns true if session exists or was created successfully
 *
 * Creates a shell-based session (not running lazygit directly) so the session
 * persists even if lazygit exits. This matches how claude sessions work.
 */
export function ensureLazygitSession(issueKey: string): boolean {
	const sessionName = `${LAZYGIT_SESSION_PREFIX}${issueKey}`;

	// Already exists?
	if (sessionExists(sessionName)) {
		return true;
	}

	// Get worktree path
	const worktreePath = getWorktreePath(issueKey);
	if (!worktreePath) {
		log.warn(`Cannot create lazygit session for ${issueKey}: no worktree found`);
		return false;
	}

	try {
		// Create detached tmux session with a shell (not running lazygit directly)
		// This ensures the session persists even if lazygit exits
		const result = spawnSync(
			'tmux',
			['new-session', '-d', '-s', sessionName, '-c', worktreePath],
			{encoding: 'utf-8', timeout: 10000},
		);

		if (result.error || result.status !== 0) {
			log.error(`Failed to create lazygit session: ${result.stderr}`);
			return false;
		}

		// Now send lazygit command to the session
		spawnSync(
			'tmux',
			['send-keys', '-t', sessionName, 'lazygit', 'Enter'],
			{encoding: 'utf-8', timeout: 5000},
		);

		log.info(`Created lazygit session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to create lazygit session for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}
