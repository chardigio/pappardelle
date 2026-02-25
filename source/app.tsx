import React, {useEffect, useState, useCallback, useRef} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import SpaceListItem from './components/SpaceListItem.tsx';
import PromptDialog from './components/PromptDialog.tsx';
import ConfirmDialog from './components/ConfirmDialog.tsx';
import HelpOverlay from './components/HelpOverlay.tsx';
import ErrorDialog from './components/ErrorDialog.tsx';
import {createLogger, subscribeToErrors, type LogEntry} from './logger.ts';

const log = createLogger('app');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

import {getIssue, getIssueCached} from './linear.ts';
import {createIssueTracker, createVcsHost} from './providers/index.ts';
import {
	getClaudeStatusInfo,
	watchStatuses,
	ensureStatusDir,
	findSpaceByStatusKey,
} from './claude-status.ts';
import {normalizeIssueIdentifier} from './issue-checker.ts';
import {
	routeSession,
	isPendingSessionResolved,
	getSpaceCount,
	buildNewSessionArgs,
	buildOpenWorkspaceArgs,
	type PendingSession,
} from './session-routing.ts';
import {
	loadConfig,
	getTeamPrefix,
	getRepoRoot,
	getRepoName,
	qualifyMainBranch,
} from './config.ts';
import {buildSpawnEnv} from './spawn-env.ts';
import {
	isInTmux,
	getWorktreePath,
	getMainWorktreeInfo,
	attachToSpace,
	displayMessageInPane,
	killSpaceSessions,
	getLinearIssuesFromTmux,
	zoomPane,
	unzoomPane,
	resizeListPaneForSessionCount,
	isVerticalLayout,
	relayoutPanes,
	getCurrentLayoutDirection,
	rebuildLayout,
	getTmuxPaneWidth,
	getTmuxPaneHeight,
} from './tmux.ts';
import {isWorktreeDirty} from './git-status.ts';
import {calculateVisibleWindow, HEADER_ROWS} from './list-view-sizing.ts';
import {useMouse} from './use-mouse.ts';
import {computePostDeleteState} from './space-utils.ts';
import type {SpaceData, PaneLayout} from './types.ts';

// Props passed from cli.tsx with pane layout info
interface AppProps {
	paneLayout: PaneLayout | null;
}

log.info('Pappardelle starting');

export default function App({paneLayout: initialPaneLayout}: AppProps) {
	const {stdout} = useStdout();

	const repoName = React.useMemo(() => {
		try {
			return getRepoName();
		} catch {
			return 'unknown';
		}
	}, []);

	const [spaces, setSpaces] = useState<SpaceData[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [loading, setLoading] = useState(true);
	const [showPromptDialog, setShowPromptDialog] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [showHelp, setShowHelp] = useState(false);
	const [showErrorDialog, setShowErrorDialog] = useState(false);
	const [pendingSession, setPendingSession] = useState<PendingSession | null>(
		null,
	);
	const [headerMessage, setHeaderMessage] = useState('');
	const [errorCount, setErrorCount] = useState(0);
	const [currentSpace, setCurrentSpace] = useState<string | null>(null);

	// Mutable pane layout — updated when layout mode switches (horizontal ↔ vertical)
	const [paneLayout, setPaneLayout] = useState<PaneLayout | null>(
		initialPaneLayout,
	);

	// Track current layout direction to detect mode switches
	const layoutDirectionRef = useRef<'horizontal' | 'vertical' | null>(
		getCurrentLayoutDirection(),
	);

	// Track if panes have been initialized
	const panesInitialized = useRef(false);

	// Track terminal dimensions with resize handling.
	// Use a lazy initializer that queries tmux directly for accurate pane
	// dimensions. stdout.rows/columns may be stale after the tmux pane split
	// because SIGWINCH hasn't been processed yet on first render.
	const [termDimensions, setTermDimensions] = useState(() => {
		if (isInTmux()) {
			return {
				rows: getTmuxPaneHeight(),
				cols: getTmuxPaneWidth(),
			};
		}
		return {
			rows: stdout?.rows ?? 40,
			cols: stdout?.columns ?? 80,
		};
	});

	// Derive whether any dialog is open (used for zoom, resize gating, and input gating)
	const anyDialogOpen =
		showPromptDialog || showDeleteConfirm || showHelp || showErrorDialog;

	// Listen for terminal resize events to update dimensions and relayout panes.
	// Screen clearing lives here (not in cli.tsx) so it's always immediately
	// followed by setTermDimensions, which guarantees a React re-render after
	// every clear. A separate listener in cli.tsx would race with Ink's render
	// cycle — clearScreen could fire *after* Ink paints, leaving a blank screen
	// with no subsequent state change to trigger a repaint.
	useEffect(() => {
		if (!stdout) return;

		let relayoutTimer: ReturnType<typeof setTimeout> | null = null;

		const handleResize = () => {
			// Clear artifacts before Ink repaints (must precede setTermDimensions
			// so the state change guarantees a fresh render after the clear)
			process.stdout.write('\x1b[2J'); // Clear screen
			process.stdout.write('\x1b[H'); // Move cursor to home
			process.stdout.write('\x1b[3J'); // Clear scrollback buffer

			setTermDimensions({
				rows: stdout.rows ?? 40,
				cols: stdout.columns ?? 80,
			});

			// Debounce tmux pane relayout (resize events fire rapidly)
			if (relayoutTimer) clearTimeout(relayoutTimer);
			relayoutTimer = setTimeout(() => {
				if (!paneLayout || anyDialogOpen) return;

				// Check if layout direction changed (crossed the threshold)
				const newDirection = getCurrentLayoutDirection();
				if (newDirection && newDirection !== layoutDirectionRef.current) {
					log.info(
						`Layout mode switch: ${layoutDirectionRef.current} → ${newDirection}`,
					);
					layoutDirectionRef.current = newDirection;

					// Rebuild panes with new orientation
					const newLayout = rebuildLayout(
						paneLayout.listPaneId,
						paneLayout.claudeViewerPaneId,
						paneLayout.lazygitViewerPaneId,
					);
					if (newLayout) {
						setPaneLayout(newLayout);
						setCurrentSpace(null); // Force re-attach
						panesInitialized.current = false;
					}
				} else {
					// Same direction — just re-proportion within current mode
					relayoutPanes(paneLayout.listPaneId, paneLayout.lazygitViewerPaneId);
				}
			}, 150);
		};

		stdout.on('resize', handleResize);
		return () => {
			stdout.off('resize', handleResize);
			if (relayoutTimer) clearTimeout(relayoutTimer);
		};
	}, [stdout, paneLayout, anyDialogOpen]);

	// Calculate dimensions
	const termHeight = termDimensions.rows;

	// Load spaces from active tmux sessions (claude-* sessions)
	const loadSpaces = useCallback(async () => {
		try {
			// Get Linear issue keys from active claude tmux sessions
			const workspaceNames = await getLinearIssuesFromTmux();

			// Build space data
			const issueFetches: Array<Promise<void>> = [];
			const spaceData: SpaceData[] = workspaceNames.map(issueKey => {
				const claudeInfo = getClaudeStatusInfo(issueKey);
				const worktreePath = getWorktreePath(issueKey);

				// Use cached issue for immediate display (avoids "Loading…" flash
				// on subsequent polls), but always call getIssue() in background
				// so that: (a) stateColorMap stays populated for main worktree
				// color, and (b) cache entries refresh when their TTL expires.
				const cached = getIssueCached(issueKey);
				issueFetches.push(
					getIssue(issueKey)
						.then(() => {})
						.catch(() => {}),
				);

				return {
					name: issueKey,
					linearIssue: cached ?? undefined,
					claudeStatus: claudeInfo.status,
					claudeTool: claudeInfo.tool,
					worktreePath,
				};
			});

			// Sort by issue number (most recent first)
			spaceData.sort((a, b) => {
				const aNum = parseInt(a.name.split('-')[1] ?? '0', 10);
				const bNum = parseInt(b.name.split('-')[1] ?? '0', 10);
				return bNum - aNum;
			});

			// Prepend the main worktree (always first, non-deletable)
			const mainInfo = await getMainWorktreeInfo();
			if (mainInfo) {
				// name stays as bare branch (used for session ops: getSessionNames adds repo prefix)
				// statusKey is repo-qualified to match what the hook writes (e.g., "pappa-chex-main")
				const repoName = getRepoName();
				const statusKey = qualifyMainBranch(repoName, mainInfo.branch);
				const mainClaudeInfo = getClaudeStatusInfo(statusKey);
				spaceData.unshift({
					name: mainInfo.branch,
					statusKey,
					worktreePath: mainInfo.path,
					isMainWorktree: true,
					isDirty: await isWorktreeDirty(mainInfo.path),
					claudeStatus: mainClaudeInfo.status,
					claudeTool: mainClaudeInfo.tool,
				});
			}

			setSpaces(spaceData);
			setLoading(false);

			// When background issue fetches complete, update spaces with newly
			// cached data. This resolves "Loading…" quickly (~1-3s) on first
			// load and picks up state changes (e.g., issue moved to "Done")
			// after cache TTL expires on subsequent polls.
			if (issueFetches.length > 0) {
				Promise.allSettled(issueFetches).then(() => {
					setSpaces(prev =>
						prev.map(s => {
							if (s.isMainWorktree) return s;
							const issue = getIssueCached(s.name);
							if (!issue) return s;
							// Reference equality: skip if same object (no refresh)
							if (s.linearIssue === issue) return s;
							return {...s, linearIssue: issue};
						}),
					);
				});
			}
		} catch (err) {
			log.error(
				'Failed to load spaces',
				err instanceof Error ? err : undefined,
			);
			setSpaces([]);
			setLoading(false);
		}
	}, []);

	// Initial load
	useEffect(() => {
		ensureStatusDir();
		loadSpaces();

		// Refresh every 10 seconds (Claude status updates arrive via file watcher
		// in real-time, so polling is only needed to detect new/removed tmux sessions)
		// Guard against overlapping runs — loadSpaces has real await points so a
		// previous invocation may still be in-flight when the next interval fires.
		let loadInFlight = false;
		const interval = setInterval(async () => {
			if (loadInFlight) return;
			loadInFlight = true;
			try {
				await loadSpaces();
			} finally {
				loadInFlight = false;
			}
		}, 10_000);

		return () => clearInterval(interval);
	}, [loadSpaces]);

	// Watch for Claude status changes
	useEffect(() => {
		const unwatch = watchStatuses((workspaceName, info) => {
			setSpaces(prev => {
				const idx = findSpaceByStatusKey(prev, workspaceName);
				if (idx === -1) return prev;
				return prev.map((s, i) =>
					i === idx
						? {...s, claudeStatus: info.status, claudeTool: info.tool}
						: s,
				);
			});
		});

		return unwatch;
	}, []);

	// Subscribe to error count for header badge
	useEffect(() => {
		const unsubscribe = subscribeToErrors((errors: LogEntry[]) => {
			setErrorCount(errors.length);
		});
		return unsubscribe;
	}, []);

	// Auto-clear pending session when the new space appears in the list
	useEffect(() => {
		if (!pendingSession) return;
		const spaceNames = spaces.map(s => s.name);
		if (isPendingSessionResolved(pendingSession, spaceNames)) {
			setPendingSession(null);
		}
	}, [spaces, pendingSession]);

	// Track whether zoom animation is in progress
	// Dialog rendering is delayed until after zoom completes to work around Ink rendering bug
	const [isZooming, setIsZooming] = useState(false);

	// Zoom/unzoom list pane when any dialog is shown/hidden
	// This gives full screen space for all dialogs
	useEffect(() => {
		if (!paneLayout) return;

		if (anyDialogOpen) {
			setIsZooming(true);
			zoomPane(paneLayout.listPaneId);
			// Wait for zoom to complete before allowing render
			setTimeout(() => setIsZooming(false), 100);
		} else {
			setIsZooming(true);
			unzoomPane(paneLayout.listPaneId);
			setTimeout(() => setIsZooming(false), 100);
		}
	}, [anyDialogOpen, paneLayout]);

	// Attach to sessions when selection changes (uses existing idow sessions)
	useEffect(() => {
		if (!paneLayout) return;
		if (spaces.length === 0) return;

		const selectedSpace = spaces[selectedIndex];
		if (!selectedSpace) return;

		// Don't switch if already showing this space
		if (currentSpace === selectedSpace.name) return;

		// Attach to sessions (creates them on-demand if they don't exist)
		const success = attachToSpace(
			paneLayout.claudeViewerPaneId,
			paneLayout.lazygitViewerPaneId,
			selectedSpace.name,
			paneLayout.listPaneId, // Keep focus on list pane
			selectedSpace.isMainWorktree
				? (selectedSpace.worktreePath ?? undefined)
				: undefined,
		);
		if (success) {
			setCurrentSpace(selectedSpace.name);
			panesInitialized.current = true;
		}
	}, [selectedIndex, spaces, paneLayout, currentSpace]);

	// Initialize panes with empty state message on first load
	useEffect(() => {
		if (!paneLayout) return;
		if (panesInitialized.current) return;
		if (loading) return;

		if (spaces.length === 0) {
			displayMessageInPane(
				paneLayout.claudeViewerPaneId,
				'No spaces found. Press n to create a new space.',
			);
			// Only clear lazygit pane if it exists (may not on narrow screens)
			if (paneLayout.lazygitViewerPaneId) {
				displayMessageInPane(paneLayout.lazygitViewerPaneId, '');
			}
			panesInitialized.current = true;
		}
	}, [paneLayout, spaces, loading]);

	// Track previous spaces count for detecting changes
	const prevSpacesCount = useRef(spaces.length);
	const initialResizeDone = useRef(false);

	// Resize list pane on initial load (after a short delay to let terminal settle)
	// This helps fix incorrect dimensions on SSH connections like Termius
	useEffect(() => {
		if (!paneLayout) return;
		if (loading) return;
		if (initialResizeDone.current) return;

		// Only resize in vertical layout mode (narrow screens)
		if (!isVerticalLayout()) {
			initialResizeDone.current = true;
			return;
		}

		// Delay slightly to let the terminal dimensions stabilize
		// (SSH connections may not have correct dimensions immediately)
		const timer = setTimeout(() => {
			resizeListPaneForSessionCount(paneLayout.listPaneId);
			initialResizeDone.current = true;
		}, 200);

		return () => clearTimeout(timer);
	}, [paneLayout, loading]);

	// Resize list pane when spaces are added or deleted (vertical layout only)
	// This keeps the list pane height optimal based on current session count
	useEffect(() => {
		if (!paneLayout) return;
		if (loading) return;

		// Only resize if count actually changed (not on every render)
		if (spaces.length === prevSpacesCount.current) return;
		prevSpacesCount.current = spaces.length;

		// Only resize in vertical layout mode (narrow screens)
		if (!isVerticalLayout()) return;

		// Resize the list pane to fit the current number of spaces
		// (tmux auto-adjusts the claude pane to fill remaining space)
		resizeListPaneForSessionCount(paneLayout.listPaneId);
	}, [paneLayout, spaces.length, loading]);

	// Open the GitHub PR / GitLab MR in browser for the selected space
	const handleOpenPR = () => {
		const space = spaces[selectedIndex];
		if (!space || space.isPending || space.isMainWorktree) {
			setHeaderMessage(space?.isMainWorktree ? 'No PR for main worktree' : '');
			if (space?.isMainWorktree) setTimeout(() => setHeaderMessage(''), 2000);
			return;
		}

		setHeaderMessage(`Opening PR for ${space.name}...`);

		try {
			const prInfo = createVcsHost().checkIssueHasPRWithCommits(space.name);
			if (prInfo.hasPR && prInfo.prUrl) {
				spawn('open', [prInfo.prUrl], {
					detached: true,
					stdio: 'ignore',
				}).unref();
				setHeaderMessage(`Opened PR #${prInfo.prNumber}`);
			} else {
				setHeaderMessage(`No PR found for ${space.name}`);
			}
		} catch {
			setHeaderMessage('Failed to look up PR');
		}
		setTimeout(() => setHeaderMessage(''), 3000);
	};

	// Open the Linear/Jira issue in browser for the selected space
	const handleOpenIssue = () => {
		const space = spaces[selectedIndex];
		if (!space || space.isPending || space.isMainWorktree) {
			setHeaderMessage(
				space?.isMainWorktree ? 'No issue for main worktree' : '',
			);
			if (space?.isMainWorktree) setTimeout(() => setHeaderMessage(''), 2000);
			return;
		}

		try {
			const url = createIssueTracker().buildIssueUrl(space.name);
			spawn('open', [url], {detached: true, stdio: 'ignore'}).unref();
			setHeaderMessage(`Opened ${space.name}`);
		} catch {
			setHeaderMessage('Failed to look up issue');
		}
		setTimeout(() => setHeaderMessage(''), 3000);
	};

	// Open the IDE (Cursor) at the worktree path for the selected space
	const handleOpenIDE = () => {
		const space = spaces[selectedIndex];
		if (!space || space.isPending) return;

		const worktreePath = space.worktreePath;
		if (!worktreePath) {
			setHeaderMessage('No worktree path found');
			setTimeout(() => setHeaderMessage(''), 2000);
			return;
		}

		spawn('cursor', [worktreePath], {detached: true, stdio: 'ignore'}).unref();
		setHeaderMessage(`Opening Cursor for ${space.name}`);
		setTimeout(() => setHeaderMessage(''), 3000);
	};

	// Focus the Claude viewer pane (Enter key)
	const handleFocusClaude = () => {
		if (!paneLayout) return;

		spawnSync('tmux', ['select-pane', '-t', paneLayout.claudeViewerPaneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});
	};

	// Handle keyboard input
	useInput(
		(input, key) => {
			if (
				showPromptDialog ||
				showDeleteConfirm ||
				showHelp ||
				showErrorDialog
			) {
				return; // Dialogs handle their own input
			}

			const totalItems = spaces.length;

			if (key.upArrow || input === 'k') {
				if (selectedIndex > 0) {
					setSelectedIndex(selectedIndex - 1);
				}
			} else if (key.downArrow || input === 'j') {
				if (selectedIndex < totalItems - 1) {
					setSelectedIndex(selectedIndex + 1);
				}
			} else if (key.return) {
				// Enter - focus the Claude viewer pane
				handleFocusClaude();
			} else if (input === 'g') {
				// 'g' to open the GitHub PR / GitLab MR in browser
				handleOpenPR();
			} else if (input === 'i') {
				// 'i' to open the Linear/Jira issue in browser
				handleOpenIssue();
			} else if (input === 'd') {
				// 'd' to open the IDE (Cursor) at the worktree path
				handleOpenIDE();
			} else if (input === 'o') {
				// 'o' to open workspace (apps, links, iTerm, etc.)
				handleOpenWorkspace();
			} else if (input === 'n') {
				// 'n' for new session
				setShowPromptDialog(true);
			} else if (key.delete) {
				// Delete key to close selected space
				const space = spaces[selectedIndex];
				if (space?.isMainWorktree) {
					setHeaderMessage('Cannot close main worktree');
					setTimeout(() => setHeaderMessage(''), 2000);
				} else if (selectedIndex < spaces.length) {
					setShowDeleteConfirm(true);
				}
			} else if (input === 'e') {
				// Show error dialog
				if (errorCount > 0) {
					setShowErrorDialog(true);
				}
			} else if (input === 'r') {
				// Refresh
				loadSpaces();
			} else if (input === '?') {
				// Show help overlay
				setShowHelp(true);
			}
		},
		{
			isActive:
				!showPromptDialog &&
				!showDeleteConfirm &&
				!showHelp &&
				!showErrorDialog,
		},
	);

	// Helper to spawn idow and capture errors
	const spawnSession = (pending: PendingSession) => {
		setPendingSession(pending);

		const child = spawn(
			path.join(SCRIPTS_DIR, 'idow'),
			buildNewSessionArgs(pending.idowArg),
			{
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				cwd: getRepoRoot(),
				env: buildSpawnEnv(getRepoRoot()),
			},
		);

		let stderrData = '';
		let stdoutData = '';

		child.stdout?.on('data', data => {
			stdoutData += data.toString();
		});

		child.stderr?.on('data', data => {
			stderrData += data.toString();
		});

		child.on('error', err => {
			log.error(`Failed to spawn idow: ${err.message}`, err);
			setPendingSession(null);
			setHeaderMessage(`Failed: ${err.message.slice(0, 40)}`);
			setTimeout(() => setHeaderMessage(''), 5000);
		});

		child.on('close', code => {
			if (code !== 0 && code !== null) {
				setPendingSession(null);
				const errorMsg =
					stderrData.trim() ||
					stdoutData.match(/Error: .*/)?.[0] ||
					`idow exited with code ${code}`;
				log.error(`idow failed (exit ${code}): ${errorMsg}`);
				setHeaderMessage(`Failed: ${errorMsg.slice(0, 40)}`);
				setTimeout(() => setHeaderMessage(''), 5000);
			} else {
				// Keep the pending row visible — the useEffect
				// watching `spaces` will clear it once the new row appears.
				loadSpaces();
			}
		});

		child.unref();
		log.info(`Started idow for pending session: ${pending.name}`);
	};

	// Open workspace apps/links/etc for the selected space (runs idow --resume)
	const handleOpenWorkspace = () => {
		const space = spaces[selectedIndex];
		if (!space) return;
		if (space.isPending) return;
		if (space.isMainWorktree) {
			setHeaderMessage('Cannot open main worktree');
			setTimeout(() => setHeaderMessage(''), 2000);
			return;
		}

		setHeaderMessage(`Opening ${space.name}...`);

		const child = spawn(
			path.join(SCRIPTS_DIR, 'idow'),
			buildOpenWorkspaceArgs(space.name),
			{
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				cwd: getRepoRoot(),
				env: buildSpawnEnv(getRepoRoot()),
			},
		);

		child.on('close', code => {
			if (code !== 0 && code !== null) {
				setHeaderMessage(`Open failed (exit ${code})`);
			} else {
				setHeaderMessage(`Opened ${space.name}`);
			}
			setTimeout(() => setHeaderMessage(''), 3000);
		});

		child.on('error', err => {
			log.error(`Failed to open workspace: ${err.message}`, err);
			setHeaderMessage(`Failed: ${err.message.slice(0, 40)}`);
			setTimeout(() => setHeaderMessage(''), 5000);
		});

		child.unref();
	};

	// Handle new session creation
	const handleNewSession = (input: string) => {
		setShowPromptDialog(false);

		// Try to normalize as an issue identifier (supports bare numbers like '400')
		let config;
		try {
			config = loadConfig();
		} catch {
			// Config loading failed, use default team prefix
			config = null;
		}

		const teamPrefix = config ? getTeamPrefix(config) : 'STA';
		const normalizedIssueKey = normalizeIssueIdentifier(input, teamPrefix);

		// Route the session: always pass just the issue key (or description) to idow.
		// idow handles both new and existing issues correctly with a bare issue key.
		const route = routeSession(normalizedIssueKey);
		const pending: PendingSession = {
			type: route.type,
			name: route.issueKey ?? '',
			idowArg: route.issueKey ?? input,
			pendingTitle: route.pendingTitle,
			prevSpaceCount: spaces.length,
		};
		spawnSession(pending);
	};

	// Handle space deletion (kills tmux sessions for the space)
	const handleDeleteSpace = () => {
		setShowDeleteConfirm(false);

		const space = spaces[selectedIndex];
		if (!space) return;

		// Kill the claude and lazygit tmux sessions for this space
		killSpaceSessions(space.name);

		// Clear the viewer panes since we killed the sessions
		if (paneLayout && currentSpace === space.name) {
			displayMessageInPane(paneLayout.claudeViewerPaneId, 'Session closed');
			displayMessageInPane(paneLayout.lazygitViewerPaneId, 'Session closed');
			setCurrentSpace(null);
		}

		// Optimistically remove the space from state immediately so the
		// reattach useEffect never sees the deleted space (loadSpaces is async,
		// so relying on it alone would leave a window where the old spaces array
		// is still in state, causing attachToSpace to respawn the killed session).
		const {filteredSpaces} = computePostDeleteState(
			spaces,
			space.name,
			selectedIndex,
		);
		setSpaces(filteredSpaces);
		setSelectedIndex(prev =>
			prev >= filteredSpaces.length && prev > 0 ? prev - 1 : prev,
		);

		// Reconcile with tmux reality in the background
		loadSpaces();
	};

	// Get space to delete (for confirmation dialog)
	const spaceToDelete = spaces[selectedIndex];

	// Build display list: real spaces + pending row (if any) at the correct position.
	// Also track the insert index so we can offset selectedIndex correctly.
	const {displaySpaces, pendingInsertIndex} = React.useMemo((): {
		displaySpaces: SpaceData[];
		pendingInsertIndex: number;
	} => {
		if (!pendingSession) return {displaySpaces: spaces, pendingInsertIndex: -1};

		// Don't show pending row if the real space already exists
		if (
			pendingSession.name &&
			spaces.some(s => s.name === pendingSession.name)
		) {
			return {displaySpaces: spaces, pendingInsertIndex: -1};
		}

		const pendingRow: SpaceData = {
			name: pendingSession.name,
			worktreePath: null,
			isPending: true,
			pendingTitle: pendingSession.pendingTitle,
		};

		if (pendingSession.type === 'issue') {
			// Insert at the correct sorted position by issue number (descending)
			const pendingNum = parseInt(pendingSession.name.split('-')[1] ?? '0', 10);
			const result = [...spaces];
			// Find the first non-main issue space with a lower number
			let insertIdx = result.findIndex(
				s =>
					!s.isMainWorktree &&
					parseInt(s.name.split('-')[1] ?? '0', 10) < pendingNum,
			);
			if (insertIdx === -1) {
				// No lower-numbered space found — append at the end
				insertIdx = result.length;
			}
			result.splice(insertIdx, 0, pendingRow);
			return {displaySpaces: result, pendingInsertIndex: insertIdx};
		}

		// Description route: insert right after main/master (position 1)
		const mainIdx = spaces.findIndex(s => s.isMainWorktree);
		const insertIdx = mainIdx + 1;
		const result = [...spaces];
		result.splice(insertIdx, 0, pendingRow);
		return {displaySpaces: result, pendingInsertIndex: insertIdx};
	}, [spaces, pendingSession]);

	// Map selectedIndex (which indexes into `spaces`) to the display list.
	// When a pending row is inserted before the selected item, shift by 1.
	const displaySelectedIndex =
		pendingInsertIndex >= 0 && selectedIndex >= pendingInsertIndex
			? selectedIndex + 1
			: selectedIndex;

	// Calculate scroll offset for large lists (using displaySpaces which includes pending row)
	const {
		scrollOffset,
		visibleCount,
		adjustedSelectedIndex: adjustedDisplayIndex,
	} = calculateVisibleWindow(
		displaySelectedIndex,
		displaySpaces.length,
		termHeight,
	);
	const visibleDisplaySpaces = displaySpaces.slice(
		scrollOffset,
		scrollOffset + visibleCount,
	);

	// Handle mouse clicks on the list
	const handleMouse = useCallback(
		(event: {x: number; y: number; button: string}) => {
			if (event.button !== 'left') return;
			if (showPromptDialog || showDeleteConfirm || showErrorDialog) return;
			if (displaySpaces.length === 0) return;

			// Calculate which row in the list was clicked
			// Layout: header (1 line) + marginBottom (1 line) = HEADER_ROWS
			const clickedRow = event.y - HEADER_ROWS;

			if (clickedRow < 0 || clickedRow >= visibleDisplaySpaces.length) return;

			// Convert visible row to absolute display index
			const displayIndex = scrollOffset + clickedRow;
			if (displayIndex < 0 || displayIndex >= displaySpaces.length) return;

			// Ignore clicks on the pending row
			if (displaySpaces[displayIndex]?.isPending) return;

			// Map display index back to spaces index (reverse the +1 offset)
			const spacesIndex =
				pendingInsertIndex >= 0 && displayIndex > pendingInsertIndex
					? displayIndex - 1
					: displayIndex;

			if (spacesIndex >= 0 && spacesIndex < spaces.length) {
				setSelectedIndex(spacesIndex);
			}
		},
		[
			displaySpaces,
			spaces.length,
			showPromptDialog,
			showDeleteConfirm,
			showErrorDialog,
			scrollOffset,
			visibleDisplaySpaces.length,
			pendingInsertIndex,
		],
	);

	useMouse(
		handleMouse,
		!showPromptDialog && !showDeleteConfirm && !showHelp && !showErrorDialog,
	);

	// Space count includes all real spaces (main worktree + issue worktrees), excludes pending rows
	const spaceCount = getSpaceCount(spaces);

	// Render the space list
	const renderList = () => {
		if (displaySpaces.length === 0) {
			return (
				<Box flexDirection="column" paddingY={1}>
					<Text dimColor>No spaces found.</Text>
					<Text dimColor>Press n to create a new space.</Text>
				</Box>
			);
		}

		return (
			<Box flexDirection="column">
				{visibleDisplaySpaces.map((space, index) => (
					<SpaceListItem
						key={space.isPending ? `pending-${space.name}` : space.name}
						space={space}
						isSelected={index === adjustedDisplayIndex}
						width={termDimensions.cols}
					/>
				))}
			</Box>
		);
	};

	// Check if running in tmux
	const inTmux = isInTmux();

	if (loading && spaces.length === 0) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text>Loading spaces...</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" height="100%">
			{/* Header */}
			<Box>
				<Text bold color="cyan">
					🍝 {repoName}
				</Text>
				{!inTmux && (
					<>
						<Text dimColor> | </Text>
						<Text color="yellow">Not in tmux</Text>
					</>
				)}
				<Text dimColor> | </Text>
				<Text dimColor>
					{spaceCount} space{spaceCount !== 1 ? 's' : ''}
					{visibleDisplaySpaces.length < displaySpaces.length &&
						` (${scrollOffset + 1}-${scrollOffset + visibleDisplaySpaces.length} of ${displaySpaces.length})`}
				</Text>
				{errorCount > 0 && (
					<>
						<Text dimColor> | </Text>
						<Text color="red">✗ {errorCount}</Text>
						<Text dimColor> (e)</Text>
					</>
				)}
			</Box>

			{/* Status message line (occupies the row between header and list) */}
			<Box>
				<Text color="yellow">{headerMessage || ' '}</Text>
			</Box>

			{/* Main content */}
			<Box flexDirection="column">
				{isZooming ? null : showPromptDialog ? (
					<PromptDialog
						onSubmit={handleNewSession}
						onCancel={() => setShowPromptDialog(false)}
					/>
				) : showDeleteConfirm && spaceToDelete ? (
					<ConfirmDialog
						title="Close Space"
						message={`Close space ${spaceToDelete.name}?`}
						detail="The worktree and git branch will remain on disk."
						onConfirm={handleDeleteSpace}
						onCancel={() => setShowDeleteConfirm(false)}
					/>
				) : showHelp ? (
					<HelpOverlay onClose={() => setShowHelp(false)} />
				) : showErrorDialog ? (
					<ErrorDialog onClose={() => setShowErrorDialog(false)} />
				) : (
					renderList()
				)}
			</Box>
		</Box>
	);
}
