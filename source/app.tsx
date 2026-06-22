import React, {useEffect, useState, useCallback, useRef, useMemo} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import TextInput from './components/TextInput.tsx';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import SpaceListItem from './components/SpaceListItem.tsx';
import PromptDialog from './components/PromptDialog.tsx';
import ConfirmDialog from './components/ConfirmDialog.tsx';
import HelpOverlay from './components/HelpOverlay.tsx';
import ErrorDialog from './components/ErrorDialog.tsx';
import UpdateBanner from './components/UpdateBanner.tsx';
import {pappardelleInstallCommand, type UpdateInfo} from './update-check.ts';
import {
	resolveUpdateKeyAction,
	buildUpdateConfirmContent,
} from './update-action.ts';
import {
	createLogger,
	subscribeToErrors,
	setStderrTerminalPassthrough,
	type LogEntry,
} from './logger.ts';

const log = createLogger('app');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

import {getIssueCached, getIssues, searchAssignedIssues} from './tracker.ts';
import {
	filterByLabels,
	filterByKeyPrefixes,
	getNewWatchlistIssues,
} from './watchlist.ts';
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
	extractIssueKeyFromIdowOutput,
	type PendingSession,
} from './session-routing.ts';
import {
	loadConfig,
	getTeamPrefix,
	getRepoRoot,
	getRepoName,
	qualifyMainBranch,
	getKeybindings,
	getResolvedWatchlists,
	getAutoRemoveWhenDone,
	expandTemplate,
	buildWorkspaceTemplateVars,
	matchProfiles,
	matchProfileByProject,
	resolvePendingProfileEmoji,
	type KeybindingConfig,
	type ResolvedWatchlist,
	type CommandConfig,
} from './config.ts';
import {findSpacesToAutoRemove} from './auto-remove.ts';
import {buildSpawnEnv} from './spawn-env.ts';
import {runPreWorkspaceDeinit} from './workspace-deinit.ts';
import {
	isInTmux,
	getWorktreePath,
	getMainWorktreeInfo,
	attachToSpace,
	displayMessageInPane,
	sendToPane,
	killSession,
	killSpaceSessions,
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
import {
	calculateVisibleWindow,
	calculateListClickRow,
} from './list-view-sizing.ts';
import {useMouse} from './use-mouse.ts';
import {filterSpaces, MAIN_WORKTREE_KEY, tearDownSpace} from './space-utils.ts';
import {getRegisteredSpaces, addSpace, removeSpace} from './space-registry.ts';
import {
	writeSpaceState,
	findLatestSessionJsonl,
	extractRecapFromJsonl,
} from './space-state.ts';
import {resolveSpaceEmoji} from './space-emoji.ts';
import {RAIL_STATUS_POLL_INTERVAL_MS} from './rail-status.ts';
import {
	watchHighlightTarget,
	findSpaceIndexByIssueKey,
	clearHighlightTarget,
} from './highlight.ts';
import type {SpaceData, PaneLayout} from './types.ts';

// Props passed from cli.tsx with pane layout info
interface AppProps {
	paneLayout: PaneLayout | null;
	commitSha: string;
	installedVersion: string | null;
	// True when running a dev/worktree build (no reachable release tag); renders
	// the help-overlay version with a `-dev` marker (STA-1494).
	isDevBuild?: boolean;
	updateCheckPromise?: Promise<UpdateInfo | null>;
}

log.info('Pappardelle starting');

export default function App({
	paneLayout: initialPaneLayout,
	commitSha,
	installedVersion,
	isDevBuild,
	updateCheckPromise,
}: AppProps) {
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
	const [runningCommand, setRunningCommand] = useState<string | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
	// Whether the "Update Pappardelle?" confirm dialog is open. Reached via the
	// always-available U key (STA-1548) — the banner's U routes here too, so the
	// installer only ever runs after an explicit confirm.
	const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
	// Measured footprint of the update banner (outer Box height + its
	// marginBottom). Reported by UpdateBanner via onMeasure — the content
	// wraps at narrow pane widths so a fixed constant is wrong. Stays at 0
	// when the banner is hidden so the mouse hit-test falls back to plain
	// HEADER_ROWS math.
	const [bannerHeight, setBannerHeight] = useState(0);
	const headerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Resolve the update check in the background. Never throws — cli.tsx
	// installs a .catch() that swallows to null.
	useEffect(() => {
		if (!updateCheckPromise) return;
		let cancelled = false;
		updateCheckPromise.then(info => {
			if (!cancelled && info) {
				setUpdateInfo(info);
				log.info(
					`Update available: ${info.installedVersion} → ${info.latestVersion}`,
				);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [updateCheckPromise]);

	const setHeaderWithTimeout = useCallback((msg: string, ms: number) => {
		if (headerTimeoutRef.current) clearTimeout(headerTimeoutRef.current);
		setHeaderMessage(msg);
		headerTimeoutRef.current = setTimeout(() => setHeaderMessage(''), ms);
	}, []);

	// Load config once at startup. Used for keybindings, emoji lookup, etc.
	// May be null if .pappardelle.yml is missing or invalid; downstream lookups
	// guard against this.
	const configMemo = React.useMemo(() => {
		try {
			return loadConfig();
		} catch (err) {
			log.error(
				'Failed to load config',
				err instanceof Error ? err : undefined,
			);
			return null;
		}
	}, []);

	// Load custom keybindings from config (once at startup)
	const keybindings = React.useMemo<KeybindingConfig[]>(() => {
		if (!configMemo) return [];
		const kb = getKeybindings(configMemo);
		log.info(`Loaded ${kb.length} custom keybindings`);
		return kb;
	}, [configMemo]);

	// Resolve profile emoji for a space. The single source of truth is the
	// profile name persisted in space-state.json — written by `idow` on
	// workspace creation, and back-filled here the first time we see a space
	// without a persisted profile but with a cached issue whose project
	// matches a configured profile.
	const resolveProfileEmojiForSpace = React.useCallback(
		(
			issueKey: string | undefined,
			cachedIssue: ReturnType<typeof getIssueCached>,
		): string | undefined =>
			resolveSpaceEmoji({
				config: configMemo,
				repoName,
				issueKey,
				cachedIssue,
			}),
		[configMemo, repoName],
	);

	// Load issue watchlists (once at startup): the top-level issue_watchlist plus
	// each profile's own issue_watchlist, all polled additively.
	const watchlists = React.useMemo<ResolvedWatchlist[]>(() => {
		try {
			const config = loadConfig();
			const resolved = getResolvedWatchlists(config);
			if (resolved.length === 0) {
				log.debug('No issue_watchlist configured — watchlist polling disabled');
			} else {
				for (const {profileName, watchlist: wl} of resolved) {
					const source = profileName ? `profile "${profileName}"` : 'top-level';
					const assigneeInfo = wl.assignee ? `assignee=${wl.assignee}, ` : '';
					const labelInfo = wl.labels?.length
						? `, labels=[${wl.labels.join(', ')}]`
						: '';
					const prefixInfo = wl.key_prefixes?.length
						? `, key_prefixes=[${wl.key_prefixes.join(', ')}]`
						: '';
					log.info(
						`Issue watchlist (${source}): ${assigneeInfo}statuses=[${wl.statuses.join(', ')}]${labelInfo}${prefixInfo}`,
					);
				}
			}

			return resolved;
		} catch (err) {
			log.debug(
				`Failed to load watchlist config: ${err instanceof Error ? err.message : String(err)}`,
			);
			return [];
		}
	}, []);

	// Build a lookup map: key char → keybinding config
	const keybindingMap = React.useMemo(() => {
		const map = new Map<string, KeybindingConfig>();
		for (const kb of keybindings) {
			map.set(kb.key, kb);
		}
		return map;
	}, [keybindings]);

	// Mutable pane layout — updated when layout mode switches (horizontal ↔ vertical)
	const [paneLayout, setPaneLayout] = useState<PaneLayout | null>(
		initialPaneLayout,
	);

	// Run the installer to update to the latest release, then quit. Invoked from
	// the update confirm dialog's onConfirm (STA-1548) — both the banner's U and
	// the always-available U funnel through that dialog.
	//
	// Order matters: if we kill the outer tmux session first, tmux SIGHUPs
	// pappardelle (its root command) before spawnSync can even fork bash, so the
	// installer never runs and the user just sees the TUI quit (STA-873).
	// Instead: release the alt screen + mouse tracking so the installer's stdout
	// is visible in the list pane, run it to completion with inherited stdio, and
	// only then tear down the outer session.
	const handleUpdateConfirmed = useCallback(() => {
		log.info('Update keybinding triggered — running install.sh');
		// Leaving the alt screen: restore stderr→terminal forwarding (suppressed
		// while the TUI owned the screen, STA-1496) so the installer's diagnostics
		// are visible.
		setStderrTerminalPassthrough(true);
		process.stdout.write('\x1b[?1006l'); // disable SGR mouse
		process.stdout.write('\x1b[?1000l'); // disable basic mouse
		process.stdout.write('\x1b[?1049l'); // exit alt screen
		spawnSync('bash', ['-c', pappardelleInstallCommand()], {
			stdio: 'inherit',
		});
		if (paneLayout) {
			killSession(`pappardelle-${repoName}`);
		}
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(0);
	}, [paneLayout, repoName]);

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
		showPromptDialog ||
		showDeleteConfirm ||
		showUpdateConfirm ||
		showHelp ||
		showErrorDialog ||
		isSearching;

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
						paneLayout.companionViewerPaneId,
					);
					if (newLayout) {
						setPaneLayout(newLayout);
						setCurrentSpace(null); // Force re-attach
						panesInitialized.current = false;
					}
				} else {
					// Same direction — just re-proportion within current mode
					relayoutPanes(
						paneLayout.listPaneId,
						paneLayout.companionViewerPaneId,
					);
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

	// Load spaces from persisted registry (survives reboots)
	const loadSpaces = useCallback(async () => {
		try {
			// Get issue keys from the persisted space registry
			const workspaceNames = getRegisteredSpaces();

			// Build space data using cached issues for immediate display
			const spaceData: SpaceData[] = workspaceNames.map(issueKey => {
				const claudeInfo = getClaudeStatusInfo(issueKey);
				const worktreePath = getWorktreePath(issueKey);
				const cached = getIssueCached(issueKey);

				return {
					name: issueKey,
					linearIssue: cached ?? undefined,
					claudeStatus: claudeInfo.status,
					claudeTool: claudeInfo.tool,
					worktreePath,
					profileEmoji: resolveProfileEmojiForSpace(issueKey, cached),
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
				// name is always MAIN_WORKTREE_KEY regardless of actual branch name.
				// This ensures stable tmux session names (claude-<repo>-main) that don't
				// change if the default branch is renamed. The inner-socket orphan
				// reaper in tmux.ts uses the same constant to exempt the main worktree
				// from being killed at startup (STA-1420).
				// statusKey is repo-qualified to match what the hook writes (e.g., "pappa-chex-master")
				const repoName = getRepoName();
				const statusKey = qualifyMainBranch(repoName, mainInfo.branch);
				const mainClaudeInfo = getClaudeStatusInfo(statusKey);
				spaceData.unshift({
					name: MAIN_WORKTREE_KEY,
					statusKey,
					worktreePath: mainInfo.path,
					isMainWorktree: true,
					isDirty: await isWorktreeDirty(mainInfo.path),
					claudeStatus: mainClaudeInfo.status,
					claudeTool: mainClaudeInfo.tool,
					profileEmoji: resolveProfileEmojiForSpace(undefined, null),
				});
			}

			// Merge in any previously-fetched railStatus so the 10s loadSpaces
			// rebuild doesn't wipe data set by the slower 60s rail poller.
			setSpaces(prev => {
				const prevRailByName = new Map(
					prev
						.filter(p => p.railStatus)
						.map(p => [p.name, p.railStatus!] as const),
				);
				return spaceData.map(s =>
					prevRailByName.has(s.name)
						? {...s, railStatus: prevRailByName.get(s.name)}
						: s,
				);
			});
			setLoading(false);

			// Batch-fetch all issues in background. This resolves "Loading…"
			// quickly (~1-3s) on first load and picks up state changes
			// (e.g., issue moved to "Done") after cache TTL expires.
			if (workspaceNames.length > 0) {
				getIssues(workspaceNames)
					.then(() => {
						setSpaces(prev =>
							prev.map(s => {
								if (s.isMainWorktree) return s;
								const issue = getIssueCached(s.name);
								if (!issue) return s;
								const nextEmoji = resolveProfileEmojiForSpace(s.name, issue);
								if (s.linearIssue === issue && s.profileEmoji === nextEmoji) {
									return s;
								}
								return {...s, linearIssue: issue, profileEmoji: nextEmoji};
							}),
						);
					})
					.catch(() => {});
			}
		} catch (err) {
			log.error(
				'Failed to load spaces',
				err instanceof Error ? err : undefined,
			);
			setSpaces([]);
			setLoading(false);
		}
	}, [resolveProfileEmojiForSpace]);

	// Initial load
	useEffect(() => {
		ensureStatusDir();
		loadSpaces();

		// Refresh every 10 seconds (Claude status updates arrive via file watcher
		// in real-time, so polling is only needed to pick up external changes)
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

	// Watch for cross-terminal highlight requests (pappardelle highlight STA-XXX)
	useEffect(() => {
		const unwatch = watchHighlightTarget(repoName, issueKey => {
			setSpaces(currentSpaces => {
				const idx = findSpaceIndexByIssueKey(currentSpaces, issueKey);
				if (idx !== -1) {
					setSelectedIndex(idx);
				}

				return currentSpaces;
			});
			// Clear outside setState so the updater stays pure
			clearHighlightTarget(repoName);
		});

		return unwatch;
	}, [repoName]);

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

		// Attach to sessions (creates them on-demand if they don't exist).
		// The issue title lets attachToSpace resolve a per-profile companion_command
		// when it has to create the companion session itself.
		const success = attachToSpace(
			paneLayout.claudeViewerPaneId,
			paneLayout.companionViewerPaneId,
			selectedSpace.name,
			paneLayout.listPaneId, // Keep focus on list pane
			selectedSpace.isMainWorktree
				? (selectedSpace.worktreePath ?? undefined)
				: undefined,
			selectedSpace.trackerIssue?.title ?? selectedSpace.linearIssue?.title,
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
			// Only clear companion pane if it exists (may not on narrow screens)
			if (paneLayout.companionViewerPaneId) {
				displayMessageInPane(paneLayout.companionViewerPaneId, '');
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
	// For main worktree, opens the repo page instead
	const handleOpenPR = () => {
		const space = spaces[selectedIndex];
		if (!space || space.isPending) return;

		if (space.isMainWorktree) {
			setHeaderMessage('Opening repo...');
			const child = spawn('gh', ['repo', 'view', '--web'], {
				detached: true,
				stdio: 'ignore',
			});
			child.unref();
			setHeaderWithTimeout('Opened repo', 3000);
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
				setHeaderWithTimeout(`Opened PR #${prInfo.prNumber}`, 3000);
			} else {
				setHeaderWithTimeout(`No PR found for ${space.name}`, 3000);
			}
		} catch {
			setHeaderWithTimeout('Failed to look up PR', 3000);
		}
	};

	// Open the Linear/Jira issue in browser for the selected space
	const handleOpenIssue = () => {
		const space = spaces[selectedIndex];
		if (!space || space.isPending || space.isMainWorktree) {
			if (space?.isMainWorktree)
				setHeaderWithTimeout('No issue for main worktree', 2000);
			return;
		}

		try {
			const url = createIssueTracker().buildIssueUrl(space.name);
			spawn('open', [url], {detached: true, stdio: 'ignore'}).unref();
			setHeaderWithTimeout(`Opened ${space.name}`, 3000);
		} catch {
			setHeaderWithTimeout('Failed to look up issue', 3000);
		}
	};

	// Open the IDE (Cursor) at the worktree path for the selected space
	const handleOpenIDE = () => {
		const space = spaces[selectedIndex];
		if (!space || space.isPending) return;

		const {worktreePath} = space;
		if (!worktreePath) {
			setHeaderWithTimeout('No worktree path found', 2000);
			return;
		}

		spawn('cursor', [worktreePath], {detached: true, stdio: 'ignore'}).unref();
		setHeaderWithTimeout(`Opening Cursor for ${space.name}`, 3000);
	};

	// Focus the Claude viewer pane (Enter key)
	const handleFocusClaude = () => {
		if (!paneLayout) return;

		spawnSync('tmux', ['select-pane', '-t', paneLayout.claudeViewerPaneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});
	};

	// Git pull in the selected space's worktree
	const handleGitPull = () => {
		const space = spaces[selectedIndex];
		if (!space || space.isPending) return;

		const {worktreePath} = space;
		if (!worktreePath) {
			setHeaderWithTimeout('No worktree path for this space', 2000);
			return;
		}

		if (runningCommand) {
			setHeaderWithTimeout(`Already running: ${runningCommand}`, 2000);
			return;
		}

		setRunningCommand('git pull');
		setHeaderMessage('Pulling...');

		const startTime = Date.now();
		const child = spawn('git', ['pull'], {
			cwd: worktreePath,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.resume();
		child.stderr?.resume();

		child.on('close', code => {
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			setRunningCommand(null);
			if (code === 0) {
				setHeaderWithTimeout(`✓ git pull (${elapsed}s)`, 5000);
			} else {
				setHeaderWithTimeout(`✗ git pull failed (exit ${code})`, 5000);
			}
		});

		child.on('error', err => {
			setRunningCommand(null);
			log.error(`git pull failed: ${err.message}`, err);
			setHeaderWithTimeout(`✗ git pull: ${err.message.slice(0, 40)}`, 5000);
		});

		child.unref();
	};

	// Send text to the Claude pane for the selected workspace
	const handleSendToClaude = (
		kb: KeybindingConfig & {send_to_claude: string},
	) => {
		if (!paneLayout) {
			setHeaderWithTimeout('No pane layout available', 2000);
			return;
		}

		const success = sendToPane(
			paneLayout.claudeViewerPaneId,
			kb.send_to_claude,
		);
		if (success) {
			setHeaderWithTimeout(`Claude: ${kb.send_to_claude}`, 3000);
		} else {
			setHeaderWithTimeout(`✗ Failed to send to Claude`, 3000);
		}
	};

	// Execute a custom keybinding command for the selected workspace
	const handleCustomKeybinding = (kb: KeybindingConfig) => {
		// Handle send_to_claude keybindings
		if (kb.send_to_claude) {
			handleSendToClaude(kb as KeybindingConfig & {send_to_claude: string});
			return;
		}

		const space = spaces[selectedIndex];
		if (!space || space.isPending) return;

		const {worktreePath} = space;
		if (!worktreePath) {
			setHeaderWithTimeout('No worktree path for this space', 2000);
			return;
		}

		if (runningCommand) {
			setHeaderWithTimeout(`Already running: ${runningCommand}`, 2000);
			return;
		}

		const startTime = Date.now();
		setRunningCommand(kb.name);
		setHeaderMessage(`Running: ${kb.name}...`);

		// Build template vars and expand the command
		const vars = buildWorkspaceTemplateVars(
			space.name,
			worktreePath,
			space.linearIssue?.title,
		);
		const expandedCommand = expandTemplate(kb.run!, vars);

		const child = spawn('bash', ['-c', expandedCommand], {
			cwd: worktreePath,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {...process.env},
		});
		child.stdout?.resume();
		child.stderr?.resume();

		child.on('close', code => {
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			setRunningCommand(null);
			if (code === 0) {
				setHeaderWithTimeout(`✓ ${kb.name} (${elapsed}s)`, 5000);
			} else {
				setHeaderWithTimeout(`✗ ${kb.name} failed (exit ${code})`, 5000);
			}
		});

		child.on('error', err => {
			setRunningCommand(null);
			log.error(`Keybinding command failed: ${err.message}`, err);
			setHeaderWithTimeout(`✗ ${kb.name}: ${err.message.slice(0, 40)}`, 5000);
		});

		child.unref();
	};

	// Handle keyboard input
	useInput(
		(input, key) => {
			if (
				showPromptDialog ||
				showDeleteConfirm ||
				showUpdateConfirm ||
				showHelp ||
				showErrorDialog
			) {
				return; // Dialogs handle their own input
			}

			const totalItems = spaces.length;

			// Check custom keybindings first — they can override default keys
			const kb = keybindingMap.get(input);
			if (kb) {
				if (!kb.disabled) {
					handleCustomKeybinding(kb);
				}
				return;
			}

			// Non-overridable built-in shortcuts
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
			} else if (input === 'n') {
				// 'n' for new session
				setShowPromptDialog(true);
			} else if (key.delete) {
				// Delete key to close selected space
				const space = spaces[selectedIndex];
				if (space?.isMainWorktree) {
					setHeaderWithTimeout('Cannot close main worktree', 2000);
				} else if (selectedIndex < spaces.length) {
					setShowDeleteConfirm(true);
				}
			} else
				switch (input) {
					case '/': {
						// Start searching spaces
						setIsSearching(true);
						setSearchQuery('');
						setSearchSelectedIndex(0);

						break;
					}
					case 'q': {
						// Quit Pappardelle — kill the tmux session so viewer panes
						// are cleaned up too (workspace sessions stay alive).
						if (paneLayout) {
							killSession(`pappardelle-${repoName}`);
						}
						// eslint-disable-next-line unicorn/no-process-exit
						process.exit(0);

						break;
					}
					case '?': {
						// Show help overlay
						setShowHelp(true);

						// Default behaviors for overridable keys (only reached if not custom-bound)

						break;
					}
					case 'g': {
						handleOpenPR();

						break;
					}
					case 'i': {
						handleOpenIssue();

						break;
					}
					case 'd': {
						handleOpenIDE();

						break;
					}
					case 'o': {
						handleOpenWorkspace();

						break;
					}
					case 'e': {
						if (errorCount > 0) {
							setShowErrorDialog(true);
						}

						break;
					}
					case 'p': {
						handleGitPull();

						break;
					}
					default: {
						const updateAction = resolveUpdateKeyAction(
							input,
							updateInfo !== null,
						);
						if (updateAction === 'open-confirm') {
							// U is always live (STA-1548): open the "are you sure?"
							// confirm dialog. The installer only runs once the user
							// confirms (handleUpdateConfirmed).
							setShowUpdateConfirm(true);
						} else if (updateAction === 'dismiss-banner') {
							// Dismiss the banner for this session. Next launch re-checks
							// against the cache on disk. Reset the measured height so
							// the mouse hit-test stops compensating for a banner that
							// is no longer rendered.
							setUpdateInfo(null);
							setBannerHeight(0);
						}
					}
				}
		},
		{
			isActive:
				!showPromptDialog &&
				!showDeleteConfirm &&
				!showUpdateConfirm &&
				!showHelp &&
				!showErrorDialog &&
				!isSearching,
		},
	);

	// Search-mode input handler: Escape to cancel, Enter to confirm, j/k to navigate filtered results
	useInput(
		(_input, key) => {
			if (key.escape) {
				setIsSearching(false);
				setSearchQuery('');
			} else if (key.return) {
				// Confirm: resolve filtered selection back to real spaces index
				const displayIdx = filteredToDisplayMap[searchSelectedIndex];
				if (displayIdx !== undefined) {
					// Map display index back to spaces index (reverse the pending offset)
					const spacesIdx =
						pendingInsertIndex >= 0 && displayIdx > pendingInsertIndex
							? displayIdx - 1
							: displayIdx;
					if (spacesIdx >= 0 && spacesIdx < spaces.length) {
						setSelectedIndex(spacesIdx);
					}
				}
				setIsSearching(false);
				setSearchQuery('');
			} else if (key.upArrow || (_input === 'k' && key.ctrl)) {
				setSearchSelectedIndex(prev => Math.max(0, prev - 1));
			} else if (key.downArrow || (_input === 'j' && key.ctrl)) {
				setSearchSelectedIndex(prev =>
					Math.min(filteredDisplaySpaces.length - 1, prev + 1),
				);
			}
		},
		{isActive: isSearching},
	);

	// Helper to spawn idow and capture errors
	const spawnSession = (pending: PendingSession) => {
		setPendingSession(pending);

		const child = spawn(
			path.join(SCRIPTS_DIR, 'idow'),
			buildNewSessionArgs(pending.idowArg, {profileName: pending.profileName}),
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
			setHeaderWithTimeout(`Failed: ${err.message.slice(0, 40)}`, 5000);
		});

		child.on('close', code => {
			if (code !== 0 && code !== null) {
				setPendingSession(null);
				const errorMsg =
					stderrData.trim() ||
					stdoutData.match(/Error: .*/)?.[0] ||
					`idow exited with code ${code}`;
				log.error(`idow failed (exit ${code}): ${errorMsg}`);
				setHeaderWithTimeout(`Failed: ${errorMsg.slice(0, 40)}`, 5000);
			} else {
				// Register the space so it persists across reboots.
				// For description routes, pending.name is empty because the issue
				// key isn't known until idow creates it. Extract it from stdout.
				const spaceKey =
					pending.name || extractIssueKeyFromIdowOutput(stdoutData);
				if (spaceKey && !pending.name) {
					log.info(`Extracted issue key from idow output: ${spaceKey}`);
				}
				if (spaceKey) {
					addSpace(spaceKey);
				}
				// Keep the pending row visible — the useEffect
				// watching `spaces` will clear it once the new row appears.
				loadSpaces();
			}
		});

		child.unref();
		log.info(`Started idow for pending session: ${pending.name}`);
	};

	// Issue watchlist polling — auto-spawn workspaces for assigned issues
	// Track which issues we've already attempted to spawn (prevents re-spawning on every poll)
	const watchlistSpawnedRef = useRef(new Set<string>());
	// Use ref for spaces length so the effect doesn't re-run on every space change
	const spacesLengthRef = useRef(spaces.length);
	spacesLengthRef.current = spaces.length;

	useEffect(() => {
		if (watchlists.length === 0) return;

		// Poll immediately on first load, then every 30 seconds
		let pollInFlight = false;

		const poll = async () => {
			if (pollInFlight) return;
			pollInFlight = true;
			log.debug('Watchlist: polling for assigned issues…');

			try {
				// Fetch the registered space set once per poll cycle; the
				// per-issue spawn guard (watchlistSpawnedRef) handles dedup both
				// across watchlists and across cycles.
				const currentSpaceNames = getRegisteredSpaces();

				for (const {profileName, watchlist} of watchlists) {
					const {
						assignee,
						statuses,
						labels: watchLabels,
						key_prefixes: watchPrefixes,
					} = watchlist;

					let issues = await searchAssignedIssues(assignee, statuses);

					// Restrict to configured issue-key prefixes (e.g. only STA-*).
					// For profile watchlists this is auto-derived from team_prefix.
					if (watchPrefixes && watchPrefixes.length > 0) {
						issues = filterByKeyPrefixes(issues, watchPrefixes);
					}

					// Apply label filter if configured
					if (watchLabels && watchLabels.length > 0) {
						issues = filterByLabels(issues, watchLabels);
					}

					if (issues.length === 0) continue;

					const newIssues = getNewWatchlistIssues(issues, currentSpaceNames);
					const source = profileName ? `profile "${profileName}"` : 'top-level';
					log.debug(
						`Watchlist (${source}): found ${issues.length} assigned issue(s), ${newIssues.length} new`,
					);

					for (const issue of newIssues) {
						// Skip if we already attempted to spawn this issue (e.g. it
						// also matched another watchlist this cycle, or a prior one).
						// First match wins by iteration order — the top-level watchlist
						// precedes profile watchlists (see getResolvedWatchlists), so on
						// the rare overlap (a profile watching the same status as the
						// top-level) the issue keeps the top-level's no-profile spawn.
						if (
							watchlistSpawnedRef.current.has(issue.identifier.toUpperCase())
						) {
							log.debug(
								`Watchlist (${source}): ${issue.identifier} already claimed by an earlier watchlist this cycle — skipping`,
							);
							continue;
						}

						watchlistSpawnedRef.current.add(issue.identifier.toUpperCase());
						log.info(
							`Watchlist (${source}): spawning workspace for ${issue.identifier} (${issue.title})`,
						);

						spawnSession({
							type: 'issue',
							name: issue.identifier,
							idowArg: issue.identifier,
							pendingTitle: `Watchlist: ${issue.title}`,
							prevSpaceCount: spacesLengthRef.current,
							// Force the owning profile so idow runs the right
							// profile-specific setup and the pending row shows its
							// emoji. null (top-level watchlist) keeps the legacy
							// behavior: no --profile, idow resolves by project.
							profileName: profileName ?? undefined,
							profileEmoji: resolvePendingProfileEmoji(configMemo, profileName),
						});
					}
				}
			} catch (err) {
				log.warn(
					'Watchlist poll failed',
					err instanceof Error ? err : undefined,
				);
			} finally {
				pollInFlight = false;
			}
		};

		// Initial poll after a short delay (let the UI settle first)
		const initialTimer = setTimeout(poll, 5_000);
		const interval = setInterval(poll, 30_000);

		return () => {
			clearTimeout(initialTimer);
			clearInterval(interval);
		};
	}, [watchlists]);

	// Rail-status polling — fetch each space's PR pipeline state + unresolved
	// review-comment count from the VCS host on RAIL_STATUS_POLL_INTERVAL_MS
	// (60s). First poll fires ~1s after mount so the icons appear quickly;
	// subsequent polls are throttled to spare gh's per-token rate limit.
	// Skips the main worktree and pending placeholder rows. Uses spacesRef
	// so the effect doesn't re-subscribe on every space mutation.
	const spacesRef = useRef(spaces);
	spacesRef.current = spaces;

	// Tear down a single space: run pre_workspace_deinit hooks, then remove
	// from the persisted registry, kill its tmux sessions, clear the viewer
	// panes if it was current, and optimistically prune it from local state.
	// Returns true on success, false if deinit aborted the removal.
	//
	// Shared by the user-pressed-`d` flow (handleDeleteSpace) and the
	// auto-remove-on-done flow.
	const deleteSpace = useCallback(
		async (space: SpaceData): Promise<boolean> => {
			// Run pre_workspace_deinit commands before deletion
			try {
				const config = loadConfig();
				const deinitCommands: CommandConfig[] = [];

				if (config.pre_workspace_deinit) {
					deinitCommands.push(...config.pre_workspace_deinit);
				}

				const trackerIssue = space.trackerIssue ?? space.linearIssue;
				let matchedProfile:
					| {profile: {pre_workspace_deinit?: CommandConfig[]}}
					| undefined;

				if (trackerIssue?.project?.name) {
					const projectMatch = matchProfileByProject(
						config,
						trackerIssue.project.name,
					);
					if (projectMatch) {
						matchedProfile = projectMatch;
					}
				}

				if (!matchedProfile && trackerIssue?.title) {
					const profileMatches = matchProfiles(config, trackerIssue.title);
					if (profileMatches.length > 0) {
						matchedProfile = profileMatches[0]!;
					}
				}

				if (matchedProfile?.profile.pre_workspace_deinit) {
					deinitCommands.push(...matchedProfile.profile.pre_workspace_deinit);
				}

				if (deinitCommands.length > 0 && space.worktreePath) {
					const result = await runPreWorkspaceDeinit(
						deinitCommands,
						space.worktreePath,
						{
							issueKey: space.name,
							repoRoot: getRepoRoot(),
							repoName: getRepoName(),
						},
					);
					if (!result.success) {
						setHeaderWithTimeout(
							`Deinit failed: ${result.failedCommand ?? 'unknown'} — deletion aborted`,
							5000,
						);
						return false;
					}
				}
			} catch (err) {
				log.error(
					'pre_workspace_deinit error',
					err instanceof Error ? err : undefined,
				);
				// Config load failure shouldn't block deletion
			}

			// STA-1420: kill tmux first, then update the registry. If the kill
			// fails (tmux hiccup, socket gone, race), leave the registry alone
			// so the user can retry — otherwise it advertises "closed" while
			// the inner-socket session is still alive, and post-STA-1416 there
			// is no `seedFromTmux` reaper to recover from that mismatch.
			const tornDown = tearDownSpace(space.name, {
				killSpaceSessions,
				removeSpace,
				onKillFailure: key =>
					setHeaderWithTimeout(
						`Failed to kill tmux sessions for ${key} — try again`,
						5000,
					),
			});
			if (!tornDown) return false;

			if (paneLayout && currentSpace === space.name) {
				displayMessageInPane(paneLayout.claudeViewerPaneId, 'Session closed');
				displayMessageInPane(
					paneLayout.companionViewerPaneId,
					'Session closed',
				);
				setCurrentSpace(null);
			}

			// Optimistically prune from local state so the reattach useEffect
			// never sees the deleted space (loadSpaces is async, so relying on
			// it alone leaves a window where attachToSpace would respawn the
			// killed session).
			setSpaces(prev => prev.filter(s => s.name !== space.name));
			return true;
		},
		[currentSpace, paneLayout, setHeaderWithTimeout],
	);

	// Auto-remove spaces whose tracker issue has reached a terminal state
	// (completed / canceled). Opt-in via top-level `auto_remove_when_done`.
	// Off by default; legacy behavior is preserved when the flag is absent.
	// Piggybacks on the 10s loadSpaces refresh so newly-Done tickets
	// disappear within a poll cycle. The in-flight ref prevents the same
	// space from being scheduled for removal twice while its deinit is
	// still running; the failed ref blocks retry storms when a space's
	// pre_workspace_deinit hook keeps failing — the tracker state stays
	// terminal across polls, so without this we'd re-fire deinit every cycle.
	const autoRemoveInFlightRef = useRef(new Set<string>());
	const autoRemoveFailedRef = useRef(new Set<string>());
	useEffect(() => {
		const autoRemoveWhenDone = configMemo
			? getAutoRemoveWhenDone(configMemo)
			: false;
		if (!autoRemoveWhenDone) return;

		const candidates = findSpacesToAutoRemove(spaces, true);
		for (const space of candidates) {
			if (autoRemoveInFlightRef.current.has(space.name)) continue;
			if (autoRemoveFailedRef.current.has(space.name)) continue;
			autoRemoveInFlightRef.current.add(space.name);
			const stateName =
				space.trackerIssue?.state.name ??
				space.linearIssue?.state.name ??
				'done';
			log.info(`Auto-removing ${space.name} (tracker state: ${stateName})`);
			deleteSpace(space)
				.then(ok => {
					if (!ok) {
						autoRemoveFailedRef.current.add(space.name);
						return;
					}
					setHeaderWithTimeout(
						`Auto-removed ${space.name} (${stateName})`,
						4000,
					);
					// Mirror handleDeleteSpace: if the selection now points past
					// the end of the shrunken list, walk it back one row.
					// spacesRef.current reflects the post-removal list because
					// deleteSpace's setSpaces has already committed by the time
					// this .then runs.
					setSelectedIndex(prev =>
						prev > 0 && prev >= spacesRef.current.length ? prev - 1 : prev,
					);
				})
				.finally(() => {
					autoRemoveInFlightRef.current.delete(space.name);
				});
		}
	}, [spaces, configMemo, deleteSpace, setHeaderWithTimeout]);

	useEffect(() => {
		let pollInFlight = false;
		const vcs = createVcsHost();

		const poll = async () => {
			if (pollInFlight) return;
			pollInFlight = true;
			try {
				const targets = spacesRef.current.filter(
					s => !s.isMainWorktree && !s.isPending && s.name.length > 0,
				);
				log.debug(
					`Rail status poll: ${targets.length} target(s) (${targets.map(t => t.name).join(', ')})`,
				);

				if (targets.length === 0) return;

				// Single bulk GraphQL request for all workspaces — one API call
				// instead of N parallel calls, avoiding GitHub rate-limit pressure.
				const lookup = await vcs.getBulkRailStatus(targets.map(t => t.name));

				// Empty Map means total failure (e.g. rate-limited) — keep old state.
				if (lookup.size === 0) return;

				for (const [name, status] of lookup) {
					log.debug(
						`Rail status ${name}: pipeline=${status.pipeline} unresolved=${status.unresolvedCommentCount} conflict=${status.hasConflict ?? false} pr=${status.prNumber ?? 'none'}`,
					);
				}

				setSpaces(prev =>
					prev.map(s => {
						if (s.isMainWorktree || s.isPending) return s;
						if (!lookup.has(s.name)) return s;
						const next = lookup.get(s.name);
						if (!next) return s;
						const prevRail = s.railStatus;
						if (
							prevRail &&
							prevRail.pipeline === next.pipeline &&
							prevRail.unresolvedCommentCount === next.unresolvedCommentCount &&
							prevRail.prNumber === next.prNumber &&
							(prevRail.hasConflict ?? false) === (next.hasConflict ?? false)
						) {
							return s;
						}

						return {...s, railStatus: next};
					}),
				);

				// Persist each space's state (rail-status + recap) so sous-chef
				// and other consumers can read cached data without re-fetching.
				// Done in a microtask to keep the render-blocking path tight.
				const repoName = getRepoName();
				queueMicrotask(() => {
					for (const [name, rail] of lookup) {
						const worktreePath = getWorktreePath(name);
						const jsonl = worktreePath
							? findLatestSessionJsonl(worktreePath)
							: null;
						const recap = jsonl ? extractRecapFromJsonl(jsonl) : null;
						writeSpaceState(repoName, name, {
							pipeline: rail.pipeline,
							unresolvedCommentCount: rail.unresolvedCommentCount,
							prNumber: rail.prNumber,
							hasConflict: rail.hasConflict ?? false,
							...(recap ? {recap} : {}),
						});
					}
				});
			} catch (err) {
				log.warn(
					'Rail status poll failed',
					err instanceof Error ? err : undefined,
				);
			} finally {
				pollInFlight = false;
			}
		};

		const initialTimer = setTimeout(poll, 1_000);
		const interval = setInterval(poll, RAIL_STATUS_POLL_INTERVAL_MS);

		return () => {
			clearTimeout(initialTimer);
			clearInterval(interval);
		};
	}, []);

	// Open workspace apps/links/etc for the selected space (runs idow --resume)
	const handleOpenWorkspace = () => {
		const space = spaces[selectedIndex];
		if (!space) return;
		if (space.isPending) return;
		if (space.isMainWorktree) {
			setHeaderWithTimeout('Cannot open main worktree', 2000);
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
				setHeaderWithTimeout(`Open failed (exit ${code})`, 3000);
			} else {
				setHeaderWithTimeout(`Opened ${space.name}`, 3000);
			}
		});

		child.on('error', err => {
			log.error(`Failed to open workspace: ${err.message}`, err);
			setHeaderWithTimeout(`Failed: ${err.message.slice(0, 40)}`, 5000);
		});

		child.unref();
	};

	// Handle new session creation.
	// profileName is whatever the PromptDialog displayed — we forward
	// it to idow via --profile so the runtime selection can't diverge from the
	// UI preview.
	const handleNewSession = (input: string, profileName: string | null) => {
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
			profileName,
			profileEmoji: resolvePendingProfileEmoji(config, profileName),
		};
		spawnSession(pending);
	};

	// Handle user-triggered space deletion (the 'd' key with confirm dialog).
	// STA-1373: keep the dialog mounted across the await so it can render its
	// "Closing space…" loading state — the pre_workspace_deinit hooks can run
	// for several seconds, and hiding the dialog up front made the TUI look
	// frozen.
	const handleDeleteSpace = async () => {
		const space = spaces[selectedIndex];
		if (!space) {
			setShowDeleteConfirm(false);
			return;
		}

		try {
			const ok = await deleteSpace(space);
			if (!ok) return;

			setSelectedIndex(prev => {
				const remaining = spaces.length - 1;
				return prev >= remaining && prev > 0 ? prev - 1 : prev;
			});

			// Reconcile with tmux reality in the background
			loadSpaces();
		} finally {
			setShowDeleteConfirm(false);
		}
	};

	// Get space to delete (for confirmation dialog)
	const spaceToDelete = spaces[selectedIndex];

	// Copy for the update confirm dialog (STA-1548). Shows the detected
	// installed→latest delta when the banner surfaced one, else the current
	// version as a fallback.
	const updateConfirmContent = buildUpdateConfirmContent(
		updateInfo,
		installedVersion,
	);

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
			// Mirror real rows' emoji slot so the Claude thinking icon stays
			// vertically aligned while the session spins up. Stays undefined
			// (no slot rendered) when the user hasn't opted into the emoji
			// rail at all — preserves byte-identical master output.
			profileEmoji: pendingSession.profileEmoji,
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

	// Filter display spaces when searching
	const {filteredDisplaySpaces, filteredToDisplayMap} = useMemo(() => {
		if (!isSearching || !searchQuery) {
			return {
				filteredDisplaySpaces: displaySpaces,
				filteredToDisplayMap: displaySpaces.map((_, i) => i),
			};
		}
		const {filtered, indexMap} = filterSpaces(displaySpaces, searchQuery);
		return {filteredDisplaySpaces: filtered, filteredToDisplayMap: indexMap};
	}, [displaySpaces, isSearching, searchQuery]);

	// Reset search selection when query changes
	useEffect(() => {
		setSearchSelectedIndex(0);
	}, [searchQuery]);

	// Map selectedIndex (which indexes into `spaces`) to the display list.
	// When a pending row is inserted before the selected item, shift by 1.
	const displaySelectedIndex =
		pendingInsertIndex >= 0 && selectedIndex >= pendingInsertIndex
			? selectedIndex + 1
			: selectedIndex;

	// Choose which list and index to use for scroll calculation
	const activeSpaces = isSearching ? filteredDisplaySpaces : displaySpaces;
	const activeSelectedIndex = isSearching
		? searchSelectedIndex
		: displaySelectedIndex;

	// Calculate scroll offset for large lists
	const {
		scrollOffset,
		visibleCount,
		adjustedSelectedIndex: adjustedDisplayIndex,
	} = calculateVisibleWindow(
		activeSelectedIndex,
		activeSpaces.length,
		termHeight,
	);
	const visibleDisplaySpaces = activeSpaces.slice(
		scrollOffset,
		scrollOffset + visibleCount,
	);

	// Handle mouse clicks on the list
	const handleMouse = useCallback(
		(event: {x: number; y: number; button: string}) => {
			if (event.button !== 'left') return;
			if (
				showPromptDialog ||
				showDeleteConfirm ||
				showUpdateConfirm ||
				showErrorDialog
			)
				return;
			if (displaySpaces.length === 0) return;

			// Map the raw mouse y into a visible-list row index. `bannerHeight`
			// is measured by UpdateBanner — it's 0 when the banner is hidden
			// and grows when content wraps at narrow pane widths. Without
			// this offset, clicks land on the row `bannerHeight` above the
			// intended target (STA-873).
			const clickedRow = calculateListClickRow({
				y: event.y,
				bannerHeight,
				visibleRows: visibleDisplaySpaces.length,
			});
			if (clickedRow === null) return;

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
			showUpdateConfirm,
			showErrorDialog,
			scrollOffset,
			visibleDisplaySpaces.length,
			pendingInsertIndex,
			bannerHeight,
		],
	);

	useMouse(
		handleMouse,
		!showPromptDialog &&
			!showDeleteConfirm &&
			!showUpdateConfirm &&
			!showHelp &&
			!showErrorDialog &&
			!isSearching,
	);

	// Space count includes all real spaces (main worktree + issue worktrees), excludes pending rows
	const spaceCount = getSpaceCount(spaces);

	// Render the space list
	const renderList = () => {
		if (activeSpaces.length === 0) {
			return (
				<Box flexDirection="column" paddingY={1}>
					<Text dimColor>
						{isSearching ? 'No matches.' : 'No spaces found.'}
					</Text>
					{!isSearching && <Text dimColor>Press n to create a new space.</Text>}
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
		// Pin the root to the measured terminal height — NOT `height="100%"`.
		// Ink full-repaints only when the rendered output is at least as tall as
		// the terminal (build/ink.js: `outputHeight >= stdout.rows` → clearTerminal);
		// otherwise it uses a cursor-relative log-update diff whose line count goes
		// stale across the `/`-search pane zoom. `height="100%"` does NOT fill the
		// screen (Ink never sets the root node's height, so it resolves against
		// `auto` and collapses to the content height) — so after the zoom grew the
		// pane and the query filtered the list short, Ink stranded the old rows and
		// pinned the query + matches to the bottom (STA-1539). A concrete height
		// keeps outputHeight === stdout.rows, so every paint is a clean full-screen
		// repaint. See app-fullscreen-height.test.ts + qa-tui.md for the proof.
		<Box flexDirection="column" height={termHeight}>
			{/* Update banner (only shown if an update is available and not dismissed) */}
			{updateInfo && (
				<UpdateBanner info={updateInfo} onMeasure={setBannerHeight} />
			)}

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
					{visibleDisplaySpaces.length < activeSpaces.length &&
						` (${scrollOffset + 1}-${scrollOffset + visibleDisplaySpaces.length} of ${activeSpaces.length})`}
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
				{isSearching ? (
					<>
						<Text color="cyan">/</Text>
						<TextInput
							value={searchQuery}
							onChange={setSearchQuery}
							placeholder="filter by key or title..."
						/>
						{filteredDisplaySpaces.length !== displaySpaces.length && (
							<Text dimColor>
								{' '}
								({filteredDisplaySpaces.length} match
								{filteredDisplaySpaces.length !== 1 ? 'es' : ''})
							</Text>
						)}
					</>
				) : (
					<Text color="yellow">{headerMessage || ' '}</Text>
				)}
			</Box>

			{/* Main content */}
			<Box flexDirection="column">
				{isZooming ? null : showUpdateConfirm ? (
					<ConfirmDialog
						title={updateConfirmContent.title}
						message={updateConfirmContent.message}
						detail={updateConfirmContent.detail}
						onConfirm={handleUpdateConfirmed}
						onCancel={() => setShowUpdateConfirm(false)}
					/>
				) : showPromptDialog ? (
					<PromptDialog
						onSubmit={handleNewSession}
						onCancel={() => setShowPromptDialog(false)}
					/>
				) : showDeleteConfirm && spaceToDelete ? (
					<ConfirmDialog
						title="Close Space"
						message={`Close space ${spaceToDelete.name}?`}
						detail="The worktree and git branch will remain on disk."
						processingMessage={`Closing space ${spaceToDelete.name}…`}
						onConfirm={handleDeleteSpace}
						onCancel={() => setShowDeleteConfirm(false)}
					/>
				) : showHelp ? (
					<HelpOverlay
						onClose={() => setShowHelp(false)}
						customKeybindings={keybindings}
						commitSha={commitSha}
						installedVersion={installedVersion}
						isDevBuild={isDevBuild}
					/>
				) : showErrorDialog ? (
					<ErrorDialog onClose={() => setShowErrorDialog(false)} />
				) : (
					renderList()
				)}
			</Box>
		</Box>
	);
}
