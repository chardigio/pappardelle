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

// Track if panes have active nested tmux clients (vs just shell)
let claudeViewerHasClient = false;
let lazygitViewerHasClient = false;

// Cache pane TTYs for fast client switching
let claudeViewerTty: string | null = null;
let lazygitViewerTty: string | null = null;

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
 * Get Linear issue keys from active claude tmux sessions
 * Extracts issue keys by removing the 'claude-' prefix from session names
 */
export function getLinearIssuesFromTmux(): string[] {
	const claudeSessions = listClaudeSessions();
	return claudeSessions
		.map(session => session.replace(CLAUDE_SESSION_PREFIX, ''))
		.filter(issueKey => /^[A-Z]+-\d+$/.test(issueKey));
}

/**
 * Get the TTY device for a pane
 * This is used to identify the nested tmux client running in a viewer pane
 */
function getPaneTty(paneId: string): string | null {
	try {
		const result = spawnSync(
			'tmux',
			['display-message', '-p', '-t', paneId, '#{pane_tty}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return null;
		}
		return result.stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Check if a tmux client exists on a given TTY
 * When we run `tmux attach` in a pane, it creates a nested client on that pane's TTY
 */
function clientExistsOnTty(tty: string): boolean {
	try {
		const result = spawnSync(
			'tmux',
			['list-clients', '-F', '#{client_tty}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return false;
		}
		const clients = result.stdout.trim().split('\n');
		return clients.includes(tty);
	} catch {
		return false;
	}
}

/**
 * Switch a tmux client to a different session
 * This is instant and invisible - much faster than detach + attach via send-keys
 */
function switchClientToSession(clientTty: string, sessionName: string): boolean {
	try {
		const result = spawnSync(
			'tmux',
			['switch-client', '-c', clientTty, '-t', sessionName],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			log.error(`Failed to switch client ${clientTty} to ${sessionName}: ${result.stderr}`);
			return false;
		}
		log.debug(`Switched client ${clientTty} to session ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to switch client to session`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Kill a tmux session by name
 * Returns true if session was killed or didn't exist
 */
export function killSession(sessionName: string): boolean {
	try {
		// Check if session exists first
		if (!sessionExists(sessionName)) {
			log.debug(`Session ${sessionName} does not exist, nothing to kill`);
			return true;
		}

		// Kill the session
		execSync(`tmux kill-session -t "${sessionName}"`, {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		log.info(`Killed session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to kill session ${sessionName}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Delete the QA simulator cloned for a space
 * The simulator is named QA-{issueKey} (e.g., QA-STA-123)
 * Returns true if simulator was deleted or didn't exist
 */
export function deleteQaSimulator(issueKey: string): boolean {
	const simulatorName = `QA-${issueKey}`;

	try {
		// Find the simulator UDID by name
		const result = spawnSync(
			'xcrun',
			['simctl', 'list', 'devices', '-j'],
			{encoding: 'utf-8', timeout: 10000},
		);

		if (result.error || result.status !== 0) {
			log.error(`Failed to list simulators: ${result.stderr}`);
			return false;
		}

		// Parse JSON output to find our simulator
		const data = JSON.parse(result.stdout) as {
			devices: Record<string, Array<{name: string; udid: string}>>;
		};

		let simulatorUdid: string | null = null;

		// Search through all runtimes for our simulator
		for (const devices of Object.values(data.devices)) {
			const found = devices.find(d => d.name === simulatorName);
			if (found) {
				simulatorUdid = found.udid;
				break;
			}
		}

		if (!simulatorUdid) {
			log.debug(`Simulator ${simulatorName} not found, nothing to delete`);
			return true;
		}

		// Delete the simulator
		const deleteResult = spawnSync(
			'xcrun',
			['simctl', 'delete', simulatorUdid],
			{encoding: 'utf-8', timeout: 30000},
		);

		if (deleteResult.error || deleteResult.status !== 0) {
			log.error(`Failed to delete simulator ${simulatorName}: ${deleteResult.stderr}`);
			return false;
		}

		log.info(`Deleted QA simulator: ${simulatorName} (${simulatorUdid})`);
		return true;
	} catch (err) {
		log.error(
			`Failed to delete simulator for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Kill both claude and lazygit sessions for a space, and delete the QA simulator
 * Returns true if all sessions were killed successfully
 */
export function killSpaceSessions(issueKey: string): boolean {
	const sessions = getSessionNames(issueKey);
	const claudeKilled = killSession(sessions.claude);
	const lazygitKilled = killSession(sessions.lazygit);

	// Delete the QA simulator (runs in background, doesn't block)
	deleteQaSimulator(issueKey);

	// If we just killed the sessions for the currently viewing space, clear the state
	if (currentlyViewingSpace === issueKey) {
		currentlyViewingSpace = null;
		claudeViewerHasClient = false;
		lazygitViewerHasClient = false;
	}

	return claudeKilled && lazygitKilled;
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

// Minimum pane widths (in characters)
const MIN_LIST_WIDTH = 40;
const MIN_CLAUDE_WIDTH = 40;
const MIN_LAZYGIT_WIDTH = 10; // Lazygit can be squished but needs at least this much

/**
 * Get current terminal/pane width from tmux
 */
function getTmuxPaneWidth(): number {
	try {
		const result = spawnSync(
			'tmux',
			['display-message', '-p', '#{pane_width}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return 120; // Default fallback
		}
		return parseInt(result.stdout.trim(), 10) || 120;
	} catch {
		return 120;
	}
}

/**
 * Calculate pane sizes ensuring minimum widths are respected.
 * Layout: [list] [claude] [lazygit]
 *
 * Priority: List gets minimum, Claude gets minimum, Lazygit gets squished if needed.
 * When there's extra space, distribute proportionally.
 */
function calculatePaneSizes(totalWidth: number): {
	listWidth: number;
	claudeWidth: number;
	lazygitWidth: number;
} {
	// Account for tmux borders (2 chars per split = 2 borders between 3 panes)
	const usableWidth = totalWidth - 2;

	// Minimum total required
	const minTotal = MIN_LIST_WIDTH + MIN_CLAUDE_WIDTH + MIN_LAZYGIT_WIDTH;

	if (usableWidth <= minTotal) {
		// Very narrow: give each the minimum, lazygit may get nothing
		const remaining = usableWidth - MIN_LIST_WIDTH - MIN_CLAUDE_WIDTH;
		return {
			listWidth: MIN_LIST_WIDTH,
			claudeWidth: MIN_CLAUDE_WIDTH,
			lazygitWidth: Math.max(0, remaining),
		};
	}

	// We have extra space beyond minimums. Distribute it.
	// Target proportions: list ~24%, claude ~38%, lazygit ~38%
	const extraSpace = usableWidth - minTotal;

	// Distribute extra space proportionally (24:38:38 ≈ 0.24:0.38:0.38)
	const listExtra = Math.floor(extraSpace * 0.24);
	const claudeExtra = Math.floor(extraSpace * 0.38);
	const lazygitExtra = extraSpace - listExtra - claudeExtra;

	return {
		listWidth: MIN_LIST_WIDTH + listExtra,
		claudeWidth: MIN_CLAUDE_WIDTH + claudeExtra,
		lazygitWidth: MIN_LAZYGIT_WIDTH + lazygitExtra,
	};
}

/**
 * Set up the initial 3-pane layout for pappardelle
 * Returns pane IDs for [list, claudeViewer, lazygitViewer]
 *
 * Layout enforces minimum widths:
 * - List pane: at least 30 characters
 * - Claude pane: at least 40 characters
 * - Lazygit can be squished on narrow screens
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

		// Get terminal width and calculate pane sizes
		const totalWidth = getTmuxPaneWidth();
		const sizes = calculatePaneSizes(totalWidth);

		log.info(
			`Terminal width: ${totalWidth}, sizes: list=${sizes.listWidth}, claude=${sizes.claudeWidth}, lazygit=${sizes.lazygitWidth}`,
		);

		// Create the right portion (claude + lazygit combined)
		// This takes everything except the list pane width
		const rightPortionWidth = sizes.claudeWidth + sizes.lazygitWidth + 1; // +1 for border

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
				String(rightPortionWidth),
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

		// Create right pane (lazygit viewer) from the claude pane
		// Only create if we have space for lazygit
		let lazygitViewerPaneId: string;

		if (sizes.lazygitWidth >= MIN_LAZYGIT_WIDTH) {
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
					String(sizes.lazygitWidth),
					'-P',
					'-F',
					'#{pane_id}',
				],
				{encoding: 'utf-8', timeout: 10000},
			);

			if (lazygitResult.error || lazygitResult.status !== 0) {
				log.error(`Failed to create lazygit viewer pane: ${lazygitResult.stderr}`);
				// Continue without lazygit pane - use empty string
				lazygitViewerPaneId = '';
			} else {
				lazygitViewerPaneId = lazygitResult.stdout.trim();
			}
		} else {
			// Not enough space for lazygit - skip it silently
			log.info(
				`Not enough space for lazygit pane (need ${MIN_LAZYGIT_WIDTH}, have ${sizes.lazygitWidth})`,
			);
			lazygitViewerPaneId = '';
		}

		// Set pane titles
		execSync(`tmux select-pane -t "${listPaneId}" -T "pappardelle"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		execSync(`tmux select-pane -t "${claudeViewerPaneId}" -T "claude-viewer"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		if (lazygitViewerPaneId) {
			execSync(`tmux select-pane -t "${lazygitViewerPaneId}" -T "lazygit-viewer"`, {
				encoding: 'utf-8',
				timeout: 5000,
			});
		}

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
 *
 * Uses tmux switch-client for instant, invisible session switching when a nested
 * client already exists in the viewer pane. Falls back to send-keys attach for
 * the initial attachment.
 *
 * This avoids the visible "TMUX= tmux attach -t session" command being typed
 * into the pane, which was jarring when rapidly navigating through spaces.
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

	// Cache pane TTYs if we haven't yet (needed for switch-client)
	if (!claudeViewerTty) {
		claudeViewerTty = getPaneTty(claudeViewerPaneId);
	}
	if (!lazygitViewerTty && lazygitViewerPaneId) {
		lazygitViewerTty = getPaneTty(lazygitViewerPaneId);
	}

	try {
		// Handle Claude viewer pane
		if (hasClaudeSession) {
			// Check if we already have a nested client running in this pane
			const hasExistingClient = claudeViewerTty && clientExistsOnTty(claudeViewerTty);

			if (hasExistingClient && claudeViewerHasClient) {
				// Fast path: switch the existing client to the new session (instant, invisible)
				switchClientToSession(claudeViewerTty!, sessions.claude);
				log.debug(`Switched claude viewer to ${sessions.claude} via switch-client`);
			} else {
				// Slow path: need to create a new nested client via send-keys
				// This happens on first attach or if the client was lost
				sendToPane(claudeViewerPaneId, `TMUX= tmux attach -t "${sessions.claude}"`);
				claudeViewerHasClient = true;
				log.info(`Attached claude viewer to ${sessions.claude} via send-keys`);
			}
		} else {
			// No session - show message (need to detach first if we have a client)
			if (claudeViewerHasClient && claudeViewerTty) {
				detachInPane(claudeViewerPaneId);
				claudeViewerHasClient = false;
			}
			sendToPane(claudeViewerPaneId, `clear && echo "No claude session for ${issueKey}"`);
		}

		// Handle lazygit viewer pane (only if we have one - may not exist on narrow screens)
		if (lazygitViewerPaneId) {
			if (hasLazygitSession) {
				// Check if we already have a nested client running in this pane
				const hasExistingClient = lazygitViewerTty && clientExistsOnTty(lazygitViewerTty);

				if (hasExistingClient && lazygitViewerHasClient) {
					// Fast path: switch the existing client to the new session
					switchClientToSession(lazygitViewerTty!, sessions.lazygit);
					log.debug(`Switched lazygit viewer to ${sessions.lazygit} via switch-client`);
				} else {
					// Slow path: create a new nested client
					sendToPane(lazygitViewerPaneId, `TMUX= tmux attach -t "${sessions.lazygit}"`);
					lazygitViewerHasClient = true;
					log.info(`Attached lazygit viewer to ${sessions.lazygit} via send-keys`);
				}
			} else {
				// No session - show message
				if (lazygitViewerHasClient && lazygitViewerTty) {
					detachInPane(lazygitViewerPaneId);
					lazygitViewerHasClient = false;
				}
				sendToPane(lazygitViewerPaneId, `clear && echo "No lazygit session for ${issueKey}"`);
			}
		} else {
			lazygitViewerHasClient = false;
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
