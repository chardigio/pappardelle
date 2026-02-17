// Tmux session attachment for pappardelle
// Attaches to existing claude-STA-XXX and lazygit-STA-XXX sessions created by idow
import {execSync, spawnSync} from 'node:child_process';
import {getRepoName} from './config.ts';
import {createLogger} from './logger.ts';
import {isSimctlUnavailableError} from './simctl-check.ts';
import {
	calculateIdealListHeightForCount,
	calculateLayoutForSize,
	MIN_LAZYGIT_WIDTH,
	NARROW_SCREEN_THRESHOLD,
	type LayoutConfig,
} from './layout-sizing.ts';

// Re-export sizing constants and functions for external use
export {
	calculateIdealListHeightForCount,
	calculateLayoutForSize,
	NARROW_SCREEN_THRESHOLD,
	MIN_LIST_WIDTH,
	MIN_CLAUDE_WIDTH,
	MIN_LAZYGIT_WIDTH,
	MAX_LIST_HEIGHT,
	DEFAULT_MIN_LIST_HEIGHT,
	type LayoutConfig,
} from './layout-sizing.ts';

const log = createLogger('tmux');

// Session naming convention (matches idow)
// Sessions are repo-qualified: claude-{repoName}-{key}, e.g. claude-pappa-chex-CHEX-313

/**
 * Get the session prefix for a given type and repo name.
 * e.g. getSessionPrefix('claude', 'pappa-chex') → 'claude-pappa-chex-'
 */
export function getSessionPrefix(
	type: 'claude' | 'lazygit',
	repoName?: string,
): string {
	const repo = repoName ?? getRepoName();
	return `${type}-${repo}-`;
}

/**
 * Extract the space key from a repo-qualified session name.
 * e.g. extractIssueKeyFromSession('claude-pappa-chex-CHEX-313', 'pappa-chex') → 'CHEX-313'
 * Returns null if the session doesn't match the expected prefix.
 */
export function extractIssueKeyFromSession(
	sessionName: string,
	repoName?: string,
): string | null {
	const prefix = getSessionPrefix('claude', repoName);
	if (!sessionName.startsWith(prefix)) return null;
	return sessionName.slice(prefix.length);
}

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
 * Get session names for a space.
 * Optional repoName parameter for testing; defaults to getRepoName().
 */
export function getSessionNames(
	issueKey: string,
	repoName?: string,
): {
	claude: string;
	lazygit: string;
} {
	const claudePrefix = getSessionPrefix('claude', repoName);
	const lazygitPrefix = getSessionPrefix('lazygit', repoName);
	return {
		claude: `${claudePrefix}${issueKey}`,
		lazygit: `${lazygitPrefix}${issueKey}`,
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
 * List all claude sessions for this repo (claude-{repoName}-*)
 */
export function listClaudeSessions(): string[] {
	try {
		const prefix = getSessionPrefix('claude');
		const output = execSync('tmux list-sessions -F "#{session_name}"', {
			encoding: 'utf-8',
			timeout: 5000,
		});

		return output
			.trim()
			.split('\n')
			.filter(name => name.startsWith(prefix));
	} catch {
		return [];
	}
}

/**
 * Get issue keys from active claude tmux sessions for this repo.
 * Extracts issue keys by removing the repo-qualified prefix from session names.
 */
export function getLinearIssuesFromTmux(): string[] {
	const claudeSessions = listClaudeSessions();
	const prefix = getSessionPrefix('claude');
	return claudeSessions
		.map(session => session.slice(prefix.length))
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
		const result = spawnSync('tmux', ['list-clients', '-F', '#{client_tty}'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
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
function switchClientToSession(
	clientTty: string,
	sessionName: string,
): boolean {
	try {
		const result = spawnSync(
			'tmux',
			['switch-client', '-c', clientTty, '-t', sessionName],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			log.error(
				`Failed to switch client ${clientTty} to ${sessionName}: ${result.stderr}`,
			);
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

	// Skip if xcrun is not available (machines without Xcode)
	const which = spawnSync('which', ['xcrun'], {
		encoding: 'utf-8',
		timeout: 5000,
	});
	if (which.status !== 0) {
		log.debug('xcrun not available, skipping simulator cleanup');
		return true;
	}

	try {
		// Find the simulator UDID by name
		const result = spawnSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
			encoding: 'utf-8',
			timeout: 10000,
		});

		if (result.error || result.status !== 0) {
			const stderr = result.stderr?.trim() ?? '';
			if (isSimctlUnavailableError(stderr)) {
				log.debug('simctl not available, skipping simulator cleanup');
				return true;
			}

			log.error(`Failed to list simulators: ${stderr}`);
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
			log.error(
				`Failed to delete simulator ${simulatorName}: ${deleteResult.stderr}`,
			);
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

// ============================================================================
// Tmux Dimension Helpers
// ============================================================================

/**
 * Get the window size (full terminal dimensions, not individual pane size)
 * This is needed for relayout calculations since individual panes may have
 * stale sizes after a resize.
 */
function getTmuxWindowSize(): {width: number; height: number} | null {
	try {
		const result = spawnSync(
			'tmux',
			['display-message', '-p', '#{window_width} #{window_height}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return null;
		}
		const parts = result.stdout.trim().split(' ');
		const width = parseInt(parts[0] ?? '', 10);
		const height = parseInt(parts[1] ?? '', 10);
		if (isNaN(width) || isNaN(height)) {
			return null;
		}
		return {width, height};
	} catch {
		return null;
	}
}

/**
 * Get current terminal/pane width from tmux
 */
export function getTmuxPaneWidth(): number {
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
 * Get current terminal/pane height from tmux
 */
export function getTmuxPaneHeight(): number {
	try {
		const result = spawnSync(
			'tmux',
			['display-message', '-p', '#{pane_height}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return 40; // Default fallback
		}
		return parseInt(result.stdout.trim(), 10) || 40;
	} catch {
		return 40;
	}
}

/**
 * Get the number of active Claude sessions (determines list pane height in vertical mode)
 */
function getActiveSessionCount(): number {
	return listClaudeSessions().length;
}

// ============================================================================
// Internal Wrapper Functions (use live tmux state)
// ============================================================================

/**
 * Calculate the ideal list pane height based on current session count.
 * Internal function that queries tmux for current state.
 */
function calculateIdealListHeight(): number {
	return calculateIdealListHeightForCount(getActiveSessionCount());
}

/**
 * Calculate pane layout based on terminal dimensions.
 * Internal function that queries tmux for current session count.
 */
function calculateLayout(
	totalWidth: number,
	totalHeight: number,
): LayoutConfig {
	return calculateLayoutForSize(
		totalWidth,
		totalHeight,
		getActiveSessionCount(),
	);
}

/**
 * Resize the list pane based on current session count (for vertical layout)
 * This should be called when spaces are added or deleted to keep the list
 * pane height optimal.
 *
 * Note: When we resize the list pane, tmux automatically adjusts the claude
 * pane to fill the remaining space, so we only need to resize one pane.
 *
 * Returns true if resize was performed, false if not applicable (horizontal layout)
 */
export function resizeListPaneForSessionCount(listPaneId: string): boolean {
	try {
		// Only resize in vertical layout mode
		const totalWidth = getTmuxPaneWidth();
		if (totalWidth >= NARROW_SCREEN_THRESHOLD) {
			log.debug('Not resizing: horizontal layout mode');
			return false;
		}

		const newListHeight = calculateIdealListHeight();

		// Resize the list pane to the new height
		const result = spawnSync(
			'tmux',
			['resize-pane', '-t', listPaneId, '-y', String(newListHeight)],
			{encoding: 'utf-8', timeout: 5000},
		);

		if (result.error || result.status !== 0) {
			log.error(`Failed to resize list pane: ${result.stderr}`);
			return false;
		}

		const sessionCount = getActiveSessionCount();
		log.info(
			`Resized list pane for ${sessionCount} sessions: list=${newListHeight} rows`,
		);
		return true;
	} catch (err) {
		log.error(
			'Failed to resize list pane',
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Check if we're in vertical layout mode (narrow screen)
 */
export function isVerticalLayout(): boolean {
	const totalWidth = getTmuxPaneWidth();
	return totalWidth < NARROW_SCREEN_THRESHOLD;
}

/**
 * Set up the pane layout for pappardelle
 * Returns pane IDs for [list, claudeViewer, lazygitViewer]
 *
 * Layout depends on screen width:
 * - Narrow screens (< 100 chars): Vertical layout [list on top] [claude below], no lazygit
 * - Wide screens (>= 100 chars): Horizontal layout [list] [claude] [lazygit]
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

		// Get terminal dimensions and calculate layout
		const totalWidth = getTmuxPaneWidth();
		const totalHeight = getTmuxPaneHeight();
		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Terminal size: ${totalWidth}x${totalHeight}, layout: ${layout.direction}`,
		);

		let claudeViewerPaneId: string;
		let lazygitViewerPaneId = ''; // Empty by default (not created for vertical layout)

		if (layout.direction === 'vertical') {
			// VERTICAL LAYOUT: list on top, claude below, no lazygit
			// Use -v for vertical split (top/bottom)
			const claudeResult = spawnSync(
				'tmux',
				[
					'split-window',
					'-v', // vertical split (top/bottom)
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(layout.claudeHeight), // claude pane gets this many rows
					'-P',
					'-F',
					'#{pane_id}',
				],
				{encoding: 'utf-8', timeout: 10000},
			);

			if (claudeResult.error || claudeResult.status !== 0) {
				log.error(
					`Failed to create claude viewer pane: ${claudeResult.stderr}`,
				);
				return null;
			}

			claudeViewerPaneId = claudeResult.stdout.trim();

			log.info(
				`Vertical layout: list=${layout.listHeight} rows, claude=${layout.claudeHeight} rows`,
			);
		} else {
			// HORIZONTAL LAYOUT: list | claude | lazygit (existing logic)
			// Create the right portion (claude + lazygit combined)
			const rightPortionWidth =
				(layout.claudeWidth ?? 40) + (layout.lazygitWidth ?? 0) + 1; // +1 for border

			const claudeResult = spawnSync(
				'tmux',
				[
					'split-window',
					'-h', // horizontal split (left/right)
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
				log.error(
					`Failed to create claude viewer pane: ${claudeResult.stderr}`,
				);
				return null;
			}

			claudeViewerPaneId = claudeResult.stdout.trim();

			// Create right pane (lazygit viewer) from the claude pane
			// Only create if we have space for lazygit
			if ((layout.lazygitWidth ?? 0) >= MIN_LAZYGIT_WIDTH) {
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
						String(layout.lazygitWidth),
						'-P',
						'-F',
						'#{pane_id}',
					],
					{encoding: 'utf-8', timeout: 10000},
				);

				if (lazygitResult.error || lazygitResult.status !== 0) {
					log.error(
						`Failed to create lazygit viewer pane: ${lazygitResult.stderr}`,
					);
					// Continue without lazygit pane
				} else {
					lazygitViewerPaneId = lazygitResult.stdout.trim();
				}
			} else {
				log.info(
					`Not enough space for lazygit pane (need ${MIN_LAZYGIT_WIDTH}, have ${layout.lazygitWidth})`,
				);
			}

			log.info(
				`Horizontal layout: list=${layout.listWidth}, claude=${layout.claudeWidth}, lazygit=${layout.lazygitWidth}`,
			);
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
			execSync(
				`tmux select-pane -t "${lazygitViewerPaneId}" -T "lazygit-viewer"`,
				{
					encoding: 'utf-8',
					timeout: 5000,
				},
			);
		}

		// Set window-level options for better focus highlighting
		// These only affect the current window, not other tmux sessions
		execSync('tmux set-option -w pane-border-style "fg=colour238"', {
			encoding: 'utf-8',
			timeout: 5000,
		});
		execSync('tmux set-option -w pane-active-border-style "fg=cyan,bold"', {
			encoding: 'utf-8',
			timeout: 5000,
		});

		// Return focus to list pane
		execSync(`tmux select-pane -t "${listPaneId}"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});

		log.info(
			`Set up pappardelle layout: list=${listPaneId}, claude=${claudeViewerPaneId}, lazygit=${
				lazygitViewerPaneId || '(none)'
			}`,
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
	mainWorktreePath?: string,
): boolean {
	// If already viewing this space, nothing to do
	if (currentlyViewingSpace === issueKey) {
		return true;
	}

	const sessions = getSessionNames(issueKey);

	// Ensure sessions exist (create if needed)
	if (mainWorktreePath) {
		ensureClaudeSession(issueKey, mainWorktreePath);
		ensureLazygitSession(issueKey, mainWorktreePath);
	} else {
		ensureClaudeSession(issueKey);
		ensureLazygitSession(issueKey);
	}

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
			const hasExistingClient =
				claudeViewerTty && clientExistsOnTty(claudeViewerTty);

			if (hasExistingClient && claudeViewerHasClient) {
				// Fast path: switch the existing client to the new session (instant, invisible)
				switchClientToSession(claudeViewerTty!, sessions.claude);
				log.debug(
					`Switched claude viewer to ${sessions.claude} via switch-client`,
				);
			} else {
				// Slow path: need to create a new nested client via send-keys
				// This happens on first attach or if the client was lost
				sendToPane(
					claudeViewerPaneId,
					`TMUX= tmux attach -t "${sessions.claude}"`,
				);
				claudeViewerHasClient = true;
				log.info(`Attached claude viewer to ${sessions.claude} via send-keys`);
			}
		} else {
			// No session - show message (need to detach first if we have a client)
			if (claudeViewerHasClient && claudeViewerTty) {
				detachInPane(claudeViewerPaneId);
				claudeViewerHasClient = false;
			}
			sendToPane(
				claudeViewerPaneId,
				`clear && echo "No claude session for ${issueKey}"`,
			);
		}

		// Handle lazygit viewer pane (only if we have one - may not exist on narrow screens)
		if (lazygitViewerPaneId) {
			if (hasLazygitSession) {
				// Check if we already have a nested client running in this pane
				const hasExistingClient =
					lazygitViewerTty && clientExistsOnTty(lazygitViewerTty);

				if (hasExistingClient && lazygitViewerHasClient) {
					// Fast path: switch the existing client to the new session
					switchClientToSession(lazygitViewerTty!, sessions.lazygit);
					log.debug(
						`Switched lazygit viewer to ${sessions.lazygit} via switch-client`,
					);
				} else {
					// Slow path: create a new nested client
					sendToPane(
						lazygitViewerPaneId,
						`TMUX= tmux attach -t "${sessions.lazygit}"`,
					);
					lazygitViewerHasClient = true;
					log.info(
						`Attached lazygit viewer to ${sessions.lazygit} via send-keys`,
					);
				}
			} else {
				// No session - show message
				if (lazygitViewerHasClient && lazygitViewerTty) {
					detachInPane(lazygitViewerPaneId);
					lazygitViewerHasClient = false;
				}
				sendToPane(
					lazygitViewerPaneId,
					`clear && echo "No lazygit session for ${issueKey}"`,
				);
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
 * Get the current layout direction based on window dimensions.
 * Used to detect when the layout mode needs to switch.
 */
export function getCurrentLayoutDirection(): 'horizontal' | 'vertical' | null {
	const windowDims = getTmuxWindowSize();
	if (!windowDims) return null;
	return windowDims.width >= NARROW_SCREEN_THRESHOLD
		? 'horizontal'
		: 'vertical';
}

/**
 * Kill a tmux pane by ID.
 * Returns true if pane was killed or didn't exist.
 */
function killPane(paneId: string): boolean {
	if (!paneId) return true;
	try {
		const result = spawnSync('tmux', ['kill-pane', '-t', paneId], {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		if (result.error || result.status !== 0) {
			log.warn(`Failed to kill pane ${paneId}: ${result.stderr}`);
			return false;
		}
		log.debug(`Killed pane ${paneId}`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rebuild the tmux pane layout when the layout direction changes.
 * Kills old viewer panes and creates new ones with the correct orientation.
 *
 * The list pane (where the Ink app runs) is preserved — only viewer panes
 * are destroyed and recreated.
 *
 * Returns the new PaneLayout, or null on failure.
 */
export function rebuildLayout(
	listPaneId: string,
	oldClaudeViewerPaneId: string,
	oldLazygitViewerPaneId: string,
): {
	listPaneId: string;
	claudeViewerPaneId: string;
	lazygitViewerPaneId: string;
} | null {
	try {
		// Detach any nested clients before killing panes
		if (oldClaudeViewerPaneId) {
			if (claudeViewerHasClient) {
				detachInPane(oldClaudeViewerPaneId);
			}
			killPane(oldClaudeViewerPaneId);
		}
		if (oldLazygitViewerPaneId) {
			if (lazygitViewerHasClient) {
				detachInPane(oldLazygitViewerPaneId);
			}
			killPane(oldLazygitViewerPaneId);
		}

		// Reset cached state since panes are destroyed
		claudeViewerHasClient = false;
		lazygitViewerHasClient = false;
		claudeViewerTty = null;
		lazygitViewerTty = null;
		currentlyViewingSpace = null;

		const cwd = process.cwd();

		// Get terminal dimensions and calculate new layout
		const windowDims = getTmuxWindowSize();
		if (!windowDims) {
			log.error('Failed to get window dimensions for rebuild');
			return null;
		}

		const {width: totalWidth, height: totalHeight} = windowDims;
		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Rebuilding layout: ${totalWidth}x${totalHeight}, mode=${layout.direction}`,
		);

		let claudeViewerPaneId: string;
		let lazygitViewerPaneId = '';

		if (layout.direction === 'vertical') {
			// VERTICAL: list on top, claude below
			const claudeResult = spawnSync(
				'tmux',
				[
					'split-window',
					'-v',
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(layout.claudeHeight),
					'-P',
					'-F',
					'#{pane_id}',
				],
				{encoding: 'utf-8', timeout: 10000},
			);

			if (claudeResult.error || claudeResult.status !== 0) {
				log.error(
					`Rebuild: failed to create claude pane: ${claudeResult.stderr}`,
				);
				return null;
			}
			claudeViewerPaneId = claudeResult.stdout.trim();

			log.info(
				`Rebuilt vertical: list=${layout.listHeight}, claude=${layout.claudeHeight}`,
			);
		} else {
			// HORIZONTAL: list | claude | lazygit
			const rightPortionWidth =
				(layout.claudeWidth ?? 40) + (layout.lazygitWidth ?? 0) + 1;

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
				log.error(
					`Rebuild: failed to create claude pane: ${claudeResult.stderr}`,
				);
				return null;
			}
			claudeViewerPaneId = claudeResult.stdout.trim();

			if ((layout.lazygitWidth ?? 0) >= MIN_LAZYGIT_WIDTH) {
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
						String(layout.lazygitWidth),
						'-P',
						'-F',
						'#{pane_id}',
					],
					{encoding: 'utf-8', timeout: 10000},
				);

				if (!lazygitResult.error && lazygitResult.status === 0) {
					lazygitViewerPaneId = lazygitResult.stdout.trim();
				}
			}

			log.info(
				`Rebuilt horizontal: list=${layout.listWidth}, claude=${layout.claudeWidth}, lazygit=${layout.lazygitWidth}`,
			);
		}

		// Set pane titles
		try {
			execSync(
				`tmux select-pane -t "${claudeViewerPaneId}" -T "claude-viewer"`,
				{encoding: 'utf-8', timeout: 5000},
			);
			if (lazygitViewerPaneId) {
				execSync(
					`tmux select-pane -t "${lazygitViewerPaneId}" -T "lazygit-viewer"`,
					{encoding: 'utf-8', timeout: 5000},
				);
			}
		} catch {
			// Non-fatal
		}

		// Return focus to list pane
		spawnSync('tmux', ['select-pane', '-t', listPaneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});

		log.info(
			`Layout rebuilt: claude=${claudeViewerPaneId}, lazygit=${lazygitViewerPaneId || '(none)'}`,
		);

		return {listPaneId, claudeViewerPaneId, lazygitViewerPaneId};
	} catch (err) {
		log.error(
			'Failed to rebuild layout',
			err instanceof Error ? err : undefined,
		);
		return null;
	}
}

/**
 * Relayout tmux panes based on current terminal dimensions.
 * Call this when the terminal is resized to keep panes properly proportioned.
 *
 * For horizontal layout: resizes list and lazygit widths (claude gets remainder)
 * For vertical layout: resizes list height (claude gets remainder)
 *
 * This only re-proportions within the current layout mode. For switching between
 * horizontal/vertical, use rebuildLayout() instead.
 */
export function relayoutPanes(
	listPaneId: string,
	lazygitViewerPaneId: string,
): boolean {
	try {
		// Get current terminal dimensions from the window (not individual panes)
		const windowDims = getTmuxWindowSize();
		if (!windowDims) {
			log.error('Failed to get tmux window dimensions for relayout');
			return false;
		}

		const {width: totalWidth, height: totalHeight} = windowDims;
		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Relayout: ${totalWidth}x${totalHeight}, mode=${layout.direction}`,
		);

		if (layout.direction === 'vertical') {
			// Vertical: resize list pane height, claude gets remainder
			if (layout.listHeight != null) {
				const result = spawnSync(
					'tmux',
					['resize-pane', '-t', listPaneId, '-y', String(layout.listHeight)],
					{encoding: 'utf-8', timeout: 5000},
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize list pane height: ${result.stderr}`);
					return false;
				}
			}
		} else {
			// Horizontal: resize list width and lazygit width, claude gets remainder
			if (layout.listWidth != null) {
				const result = spawnSync(
					'tmux',
					['resize-pane', '-t', listPaneId, '-x', String(layout.listWidth)],
					{encoding: 'utf-8', timeout: 5000},
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize list pane width: ${result.stderr}`);
					return false;
				}
			}

			if (lazygitViewerPaneId && layout.lazygitWidth != null) {
				const result = spawnSync(
					'tmux',
					[
						'resize-pane',
						'-t',
						lazygitViewerPaneId,
						'-x',
						String(layout.lazygitWidth),
					],
					{encoding: 'utf-8', timeout: 5000},
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize lazygit pane width: ${result.stderr}`);
					// Non-fatal, continue
				}
			}
		}

		log.info('Relayout completed successfully');
		return true;
	} catch (err) {
		log.error(
			'Failed to relayout panes',
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Zoom a pane to take up the full terminal window
 * Uses tmux's built-in zoom feature which maximizes the pane
 */
export function zoomPane(paneId: string): boolean {
	try {
		// Check if already zoomed
		const checkResult = spawnSync(
			'tmux',
			['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}'],
			{encoding: 'utf-8', timeout: 5000},
		);

		if (checkResult.stdout.trim() === '1') {
			log.debug(`Pane ${paneId} is already zoomed`);
			return true;
		}

		const result = spawnSync('tmux', ['resize-pane', '-Z', '-t', paneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});

		if (result.error || result.status !== 0) {
			log.error(`Failed to zoom pane ${paneId}: ${result.stderr}`);
			return false;
		}

		log.info(`Zoomed pane ${paneId}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to zoom pane ${paneId}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Unzoom a pane to restore the normal layout
 */
export function unzoomPane(paneId: string): boolean {
	try {
		// Check if actually zoomed
		const checkResult = spawnSync(
			'tmux',
			['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}'],
			{encoding: 'utf-8', timeout: 5000},
		);

		if (checkResult.stdout.trim() !== '1') {
			log.debug(`Pane ${paneId} is not zoomed, nothing to unzoom`);
			return true;
		}

		const result = spawnSync('tmux', ['resize-pane', '-Z', '-t', paneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});

		if (result.error || result.status !== 0) {
			log.error(`Failed to unzoom pane ${paneId}: ${result.stderr}`);
			return false;
		}

		log.info(`Unzoomed pane ${paneId}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to unzoom pane ${paneId}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Get the worktree path for an issue key
 */
export function getWorktreePath(issueKey: string): string | null {
	try {
		const homeDir = process.env['HOME'] ?? '';
		const repoName = getRepoName();
		const worktreePath = `${homeDir}/.worktrees/${repoName}/${issueKey}`;

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
 * Get the main worktree info (path and branch name).
 * The main worktree is the original git checkout (not a `git worktree add` worktree).
 * Returns null if detection fails.
 */
export function getMainWorktreeInfo(): {
	path: string;
	branch: string;
} | null {
	try {
		// `git worktree list --porcelain` outputs blocks like:
		//   worktree /path/to/repo
		//   HEAD abc123
		//   branch refs/heads/master
		//
		// The first block is always the main worktree.
		const output = execSync('git worktree list --porcelain', {
			encoding: 'utf-8',
			timeout: 5000,
		});

		const lines = output.split('\n');
		let path: string | null = null;
		let branch: string | null = null;

		for (const line of lines) {
			if (line.startsWith('worktree ') && !path) {
				path = line.slice('worktree '.length);
			} else if (line.startsWith('branch ') && !branch) {
				// e.g. "branch refs/heads/master" → "master"
				branch = line.slice('branch '.length).replace('refs/heads/', '');
			} else if (line === '' && path) {
				// End of first worktree block
				break;
			}
		}

		if (path && branch) {
			return {path, branch};
		}
		return null;
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
export function ensureClaudeSession(
	issueKey: string,
	explicitWorktreePath?: string,
): boolean {
	const sessionName = getSessionNames(issueKey).claude;

	// Already exists?
	if (sessionExists(sessionName)) {
		return true;
	}

	// Get worktree path
	const worktreePath = explicitWorktreePath ?? getWorktreePath(issueKey);
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
			[
				'send-keys',
				'-t',
				sessionName,
				'claude --dangerously-skip-permissions',
				'Enter',
			],
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
export function ensureLazygitSession(
	issueKey: string,
	explicitWorktreePath?: string,
): boolean {
	const sessionName = getSessionNames(issueKey).lazygit;

	// Already exists?
	if (sessionExists(sessionName)) {
		return true;
	}

	// Get worktree path
	const worktreePath = explicitWorktreePath ?? getWorktreePath(issueKey);
	if (!worktreePath) {
		log.warn(
			`Cannot create lazygit session for ${issueKey}: no worktree found`,
		);
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
		spawnSync('tmux', ['send-keys', '-t', sessionName, 'lazygit', 'Enter'], {
			encoding: 'utf-8',
			timeout: 5000,
		});

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
