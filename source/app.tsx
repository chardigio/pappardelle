import {recordSupervision} from './supervise-log.ts';
import {stripVTControlCharacters} from 'node:util';
import {useKeyboard, useRenderer} from '@opentui/react';
import {quitOnCtrlC, quitOnSignals} from './render-tui.ts';
import type {CliRenderer, KeyEvent} from '@opentui/core';
import {shortcutKey} from './tui-key.ts';
import {textAttributes, terminalColor, dimText} from './tui-style.ts';
import React, {useEffect, useState, useCallback, useRef, useMemo} from 'react';

import TextInput from './components/TextInput.tsx';
import PaneFrame, {PANE_FRAME_SIZE} from './components/PaneFrame.tsx';
import {spawn, spawnSync} from 'node:child_process';
import {spawnQuietCommand} from './quiet-command.ts';
import {once} from 'node:events';
import {openPR} from './open-pr.ts';
import {WorkspaceCloseTasks} from './workspace-close.ts';
import {WorkspaceRefresh, compareSpaceNames} from './workspace-refresh.ts';
import {PaneLayoutTask, syncTerminalDimensions} from './pane-layout-task.ts';
import {scriptsDir, cliFilePath} from './runtime.ts';
import fs from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';

import SpaceListItem, {ROW_PADDING_CELLS} from './components/SpaceListItem.tsx';
import PromptDialog from './components/PromptDialog.tsx';
import ConfirmDialog from './components/ConfirmDialog.tsx';
import HelpOverlay from './components/HelpOverlay.tsx';
import ErrorDialog from './components/ErrorDialog.tsx';
import UpdateBanner from './components/UpdateBanner.tsx';
import TruncatedLine, {type Run} from './components/TruncatedLine.tsx';
import {runUpdateScript, type UpdateInfo} from './update-check.ts';
import {
	closeTuiLayout,
	paneRespawned,
	installedLaunchCommand,
	restartOwnTui,
} from './tui-sessions.ts';
import {
	DEFAULT_REPO_STATE_ROOT,
	clearDeadRestartLock,
	writeTuiMarker,
} from './tui-marker.ts';
import {
	resolveUpdateKeyAction,
	buildUpdateConfirmContent,
} from './update-action.ts';
import {
	isCloseSpaceKey,
	isFocusAgentKey,
	isRailInputBlocked,
} from './rail-input.ts';
import {
	createLogger,
	subscribeToErrors,
	clearRecentErrors,
	dismissRecentErrors,
	getRecentErrors,
	setStderrTerminalPassthrough,
	type LogEntry,
} from './logger.ts';

const log = createLogger('app');

const SCRIPTS_DIR = scriptsDir;

// Spawn errors carry a whole command line; the header only has room for the
// part that names what went wrong.
const IDE_ERROR_HEADER_CHARS = 40;

import {
	claimIssue,
	getIssueCached,
	getIssues,
	searchAssignedIssues,
} from './tracker.ts';
import {initStateColorOverrides} from './state-color-override.ts';
import {
	filterByLabels,
	filterByKeyPrefixes,
	getNewWatchlistIssues,
	sortIssuesByCreatedAt,
	watchlistSourceId,
} from './watchlist.ts';
import {createIssueTracker, createVcsHost} from './providers/index.ts';
import {WorkspaceStatuses} from './workspace-status.ts';
import {readableHookStatusKey} from './claude-status.ts';
import {getSessionNames} from './tmux.ts';
import {removeProgramSnapshots} from './program-status-monitor.ts';
import {normalizeIssueIdentifier} from './issue-checker.ts';
import {resolveSpaceKey} from './issue-utils.ts';
import {openIssueForKey} from './open-issue.ts';
import {
	applyStateChoice,
	choiceLabel,
	type StateChoice,
} from './close-state-choice.ts';
import CloseSpaceDialog from './components/CloseSpaceDialog.tsx';
import {
	isPopupAvailable,
	openPopup,
	runCommandPopup,
	type PopupHandlers,
} from './popup/host.ts';
import type {PopupSpec} from './popup/spec.ts';
import {shellQuote} from './shell-quote.ts';
import {
	routeSession,
	isPendingSessionResolved,
	getSpaceCount,
	buildNewSessionArgs,
	buildOpenWorkspaceArgs,
	extractIssueKeyFromIdowOutput,
	idowSkippedAgentOverride,
	type PendingSession,
} from './session-routing.ts';
import {
	getDefaultHomeConfigDir,
	loadConfig,
	sousChefLaunch,
	getStateColors,
	getBeadsPrefixes,
	readBeadsIssuePrefix,
	getTeamPrefix,
	getRepoRoot,
	getMainRepoRoot,
	getSousChefKey,
	getRepoName,
	getKeybindings,
	getResolvedWatchlists,
	getAutoRemoveWhenDone,
	getListLayout,
	getRailGroups,
	isRailGroupedByStatus,
	expandTemplate,
	buildWorkspaceTemplateVars,
	getIdeCommand,
	DEFAULT_IDE_COMMAND,
	resolvePendingProfileEmoji,
	type KeybindingConfig,
	type PappardelleConfig,
	type ResolvedWatchlist,
} from './config.ts';
import {useSpaceSelection} from './use-space-selection.ts';
import {
	buildRailRows,
	flatRailRows,
	searchRailRows,
	isAgentSpace,
	isSpaceRow,
	nextSelectableRow,
	railRowHeight,
	resolveCursorRow,
	type RailRow,
} from './rail-groups.ts';
import RailGroupHeader from './components/RailGroupHeader.tsx';
import RailDivider from './components/RailDivider.tsx';
import {findSpacesToAutoRemove} from './auto-remove.ts';
import {
	buildKillDoneConfirmContent,
	findDoneSpaces,
	formatKillDoneResult,
	KILL_DONE_EMPTY_MESSAGE,
} from './kill-done-spaces.ts';
import {buildSpawnEnv} from './spawn-env.ts';
import {
	buildConfigFixConfirmContent,
	buildConfigFixPrompt,
	buildConfigMigrationConfirmContent,
	confirmConfigMigrations,
	dismissResolvedDeprecationWarnings,
	planConfigMigrations,
	type ConfigMigration,
} from './config-migration.ts';
import {runCloseHooks, shouldAttach} from './close-space.ts';
import {StartupQueue, scheduleWorkspaceStart} from './startup-queue.ts';
import {runWorkspaceSetup} from './workspace-startup.ts';
import {AttachmentGate} from './attachment-gate.ts';
import {LatestTask} from './latest-task.ts';
import {
	sendToSelectedAgent,
	type SendToClaudeResult,
} from './send-to-claude.ts';
import {
	isInTmux,
	getWorktreePath,
	getWorktreePathAsync,
	getMainWorktreeInfo,
	attachToSpace,
	displayMessageInPane,
	sendToSpaceAgent,
	focusPane,
	getCurrentlyViewingSpace,
	killSession,
	panePid,
	currentDefaultServerSession,
	defaultOuterTmuxRunner,
	defaultServerTmuxRunner,
	killSpaceSessions,
	deleteQaSimulator,
	displayMessageInPaneAsync,
	reconcilePaneLayout,
	runningAgentProfile,
	installSousChefKey,
	measureCompanionColumnWidth,
	setSpaceCompanionWidth,
	setSpaceCompanionDragHandler,
	syncCompanionSplits,
	takePendingSplitSync,
	closeCompanionSplitPanes,
	companionSplitPaneIds,
} from './tmux.ts';
import {
	getCompanionWidth,
	setCompanionWidth,
	watchLayoutRequests,
	writeLayoutAck,
} from './companion-width.ts';
import {isWorktreeDirty} from './git-status.ts';
import {
	calculateRowWindow,
	HEADER_ROWS,
	statusLineFits,
} from './list-view-sizing.ts';
import {MAIN_WORKTREE_KEY, tearDownSpace} from './space-utils.ts';
import {
	filterSpaces,
	highlightedIndex,
	searchKeyStep,
	type RailSearch,
} from './rail-search.ts';
import {
	getRegisteredSpaces,
	getRegisteredSpacesAsync,
	addSpace,
	removeSpace,
	tryReserveWatchlistSlots,
	releaseWatchlistReservation,
} from './space-registry.ts';
import {
	readSpaceState,
	writeSpaceState,
	findLatestSessionJsonl,
	extractRecapFromJsonl,
	getSpaceStateDir,
} from './space-state.ts';
import {useRailStatusPolling} from './use-rail-status-polling.ts';
import {
	resolveSpaceEmojiAsync,
	resolveSpaceProfileName,
} from './space-emoji.ts';
import {
	watchHighlightTarget,
	clearHighlightTarget,
	findSpaceIndexByIssueKey,
	highlightWriteCommand,
} from './highlight.ts';
import {skillRoots, skillSnapshot} from './skill-completion.ts';
import {startupTrace} from './startup-trace.ts';
import type {SpaceData, PaneLayout} from './types.ts';

/** A reader whose first answer was already asked for. */
function firstFrom<T>(
	first: Promise<T> | undefined,
	read: () => Promise<T>,
): () => Promise<T> {
	let pending = first;
	return async () => {
		const value = pending;
		pending = undefined;
		return value ?? read();
	};
}

function claimIssueInBackground(issueKey: string): void {
	void claimIssue(issueKey).then(claimed => {
		if (claimed) log.info(`Claimed ${issueKey} — removed from ready work`);
	});
}

const closeLayoutDeps = {
	currentSession: () => currentDefaultServerSession(process.env),
	killSession,
	layoutTmux: defaultOuterTmuxRunner,
	splitPanes: companionSplitPaneIds,
};

/**
 * Workspace sessions stay alive; only the layout closes. The renderer resets
 * the terminal first: closing the layout can kill the session that owns this
 * pty.
 */
export function quitTui(
	renderer: CliRenderer,
	repoName: string,
	paneLayout: PaneLayout | null,
): void {
	renderer.destroy();
	if (paneLayout) closeTuiLayout(repoName, paneLayout, closeLayoutDeps);
}

// Props passed from cli.tsx with pane layout info
interface AppProps {
	/** Reads started before the renderer loaded, for the first list drawn. */
	initialWorkspaces?: {
		registry: ReturnType<typeof getRegisteredSpacesAsync>;
		mainWorktree: ReturnType<typeof getMainWorktreeInfo>;
	};
	firstRailPaint?: Promise<void>;
	onFirstRailPaint?: () => void;
	paneLayout: PaneLayout | null;
	commitSha: string;
	installedVersion: string | null;
	// True when running a dev/worktree build (no reachable release tag); renders
	// the help-overlay version with a `-dev` marker (STA-1494).
	isDevBuild?: boolean;
	updateCheckPromise?: Promise<UpdateInfo | null>;
}

export default function App({
	initialWorkspaces,
	firstRailPaint,
	onFirstRailPaint,
	paneLayout: initialPaneLayout,
	commitSha,
	installedVersion,
	isDevBuild,
	updateCheckPromise,
}: AppProps) {
	const renderer = useRenderer();
	const {stdout} = process;

	const repoName = React.useMemo(() => {
		try {
			return getRepoName();
		} catch {
			return 'unknown';
		}
	}, []);
	const savedProfileFor = React.useCallback(
		(input: string, config: PappardelleConfig | null) => {
			const key = resolveSpaceKey(
				input,
				config ? getTeamPrefix(config) : 'STA',
				createIssueTracker().name,
				config ? getBeadsPrefixes(config, readBeadsIssuePrefix()) : [],
			);
			return key ? readSpaceState(repoName, key)?.profile : undefined;
		},
		[repoName],
	);

	const {
		spaces,
		setSpaces,
		selectedIndex,
		setSelectedIndex,
		selectSpace,
		current: currentSelection,
	} = useSpaceSelection();
	const selectedSpaceNow = useCallback(() => {
		const {spaces, selectedIndex} = currentSelection();
		return spaces[selectedIndex];
	}, [currentSelection]);
	const spacesRef = useRef(spaces);
	spacesRef.current = spaces;
	const statusKeysRef = useRef(new Set<string>());
	const workspaceStatuses = useMemo(
		() =>
			new WorkspaceStatuses(
				repoName,
				key => getSessionNames(key, repoName).agent,
			),
		[repoName],
	);
	statusKeysRef.current = useMemo(
		() => new Set(spaces.map(space => space.statusKey ?? space.name)),
		[spaces],
	);
	const [loading, setLoading] = useState(true);
	const [backgroundReady, setBackgroundReady] = useState(!firstRailPaint);
	useEffect(() => {
		if (firstRailPaint)
			void firstRailPaint.then(() => setBackgroundReady(true));
	}, [firstRailPaint]);
	const [showPromptDialog, setShowPromptDialog] = useState(false);
	// Snapshotted at keypress like killDoneTargets below, so the 10s poll can't
	// move the selection onto a different space while the confirm is open.
	const [deleteTarget, setDeleteTarget] = useState<SpaceData | null>(null);
	// The batch of done/canceled spaces the `K` shortcut is asking about
	// (STA-2111). Null means the dialog is closed. The list is snapshotted at
	// keypress time rather than recomputed on render, because the 10s
	// loadSpaces poll can land while the dialog is open — the user must close
	// exactly the set the user was shown a count for.
	const [killDoneTargets, setKillDoneTargets] = useState<SpaceData[] | null>(
		null,
	);
	const [showHelp, setShowHelp] = useState(false);
	const [showErrorDialog, setShowErrorDialog] = useState(false);
	const [configMigrations, setConfigMigrations] = useState<
		ConfigMigration[] | null
	>(null);
	const [pendingSession, setPendingSession] = useState<PendingSession | null>(
		null,
	);
	const [headerMessage, setHeaderMessage] = useState('');
	const headerGeneration = useRef(0);
	const [recentErrors, setRecentErrors] = useState<LogEntry[]>([]);
	const errorCount = recentErrors.length;
	const [runningCommand, setRunningCommand] = useState<string | null>(null);
	// Several keys can arrive in one input write, and their handlers all run
	// before the next render. Search keys read the ref so each acts on what
	// the previous one left; the state copy is for drawing.
	const searchNow = useRef<RailSearch | null>(null);
	const [search, setSearch] = useState<RailSearch | null>(null);
	// Until the search row is drawn there is no input to take typed text.
	const searchInputDrawn = useRef(false);
	// A search reopened before its closing is drawn gets a new input, not the
	// closed one with its text.
	const [searchSession, setSearchSession] = useState(0);
	const updateSearch = useCallback((next: RailSearch | null) => {
		if (!next) searchInputDrawn.current = false;
		searchNow.current = next;
		setSearch(next);
	}, []);
	const isSearching = search !== null;
	const displaySpacesRef = useRef<SpaceData[]>([]);
	useEffect(() => {
		searchInputDrawn.current = isSearching;
	}, [isSearching, searchSession]);
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
	useEffect(
		() => () => {
			headerGeneration.current++;
			if (headerTimeoutRef.current) clearTimeout(headerTimeoutRef.current);
		},
		[],
	);

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

	const showHeaderMessage = useCallback((msg: string) => {
		if (headerTimeoutRef.current) clearTimeout(headerTimeoutRef.current);
		// Messages often quote script output, whose color codes OpenTUI would
		// print as literal text.
		setHeaderMessage(stripVTControlCharacters(msg));
		return ++headerGeneration.current;
	}, []);

	const setHeaderWithTimeout = useCallback(
		(msg: string, ms: number) => {
			showHeaderMessage(msg);
			headerTimeoutRef.current = setTimeout(() => showHeaderMessage(''), ms);
		},
		[showHeaderMessage],
	);

	// Identifies the most recent `d` launch so a slow editor's failure can't
	// overwrite the header of whatever the user did after it.
	const ideLaunchCounter = useRef(0);
	const openPRRequest = useRef(0);

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

	const railGrouped = isRailGroupedByStatus(configMemo);
	const [stackedLayout, setStackedLayout] = useState(false);
	const railGroups = useMemo(() => getRailGroups(configMemo), [configMemo]);
	// Grouped rows and cursor from the live selection, not the last render: one
	// input write can carry several keys, and each must see what the previous
	// one did.
	const railNow = useCallback(() => {
		if (!railGrouped || searchNow.current) return null;
		const {spaces, selectedIndex} = currentSelection();
		const rows = buildRailRows({
			displaySpaces: [
				...spaces,
				...displaySpacesRef.current.filter(space => space.isPending),
			],
			groups: railGroups,
			headers: !stackedLayout,
		});
		return {rows, cursor: resolveCursorRow(rows, spaces[selectedIndex])};
	}, [railGrouped, railGroups, stackedLayout, currentSelection]);
	const mainLabel = sousChefLaunch(configMemo)?.name;

	// Install the user's issue-status color overrides before anything renders,
	// so the ticket rail's first paint already uses them (STA-2070). A useMemo
	// runs during App's own render, which precedes every SpaceListItem child.
	React.useMemo(() => {
		initStateColorOverrides(getStateColors(configMemo));
	}, [configMemo]);

	// Load custom keybindings from config (once at startup)
	const keybindings = React.useMemo<KeybindingConfig[]>(() => {
		if (!configMemo) return [];
		const kb = getKeybindings(configMemo);
		log.info(`Loaded ${kb.length} custom keybindings`);
		return kb;
	}, [configMemo]);

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
					const maxInfo =
						wl.max_workspaces === undefined ? '' : `, max=${wl.max_workspaces}`;
					log.info(
						`Issue watchlist (${source}): ${assigneeInfo}statuses=[${wl.statuses.join(', ')}]${labelInfo}${prefixInfo}${maxInfo}`,
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

	// Run the installer to update to the latest release, then restart. Invoked from
	// the update confirm dialog's onConfirm (STA-1548) — both the banner's U and
	// the always-available U funnel through that dialog.
	//
	// Order matters: if we kill the outer tmux session first, tmux SIGHUPs
	// pappardelle (its root command) before spawnSync can even fork bash, so the
	// installer never runs and the user just sees the TUI quit (STA-873).
	// Instead: release the alt screen + mouse tracking so the installer's stdout
	// is visible in the list pane, run it to completion with inherited stdio, and
	// only then tear down the outer session.
	const handleUpdateConfirmed = useCallback(async () => {
		log.info('Update keybinding triggered — running install.sh');
		// Leaving the alt screen: restore stderr→terminal forwarding (suppressed
		// while the TUI owned the screen, STA-1496) so the installer's diagnostics
		// are visible.
		setStderrTerminalPassthrough(true);
		await renderer.suspend();
		runUpdateScript({waitOnFailure: true});
		// Reruns the TUI through the shim the installer just re-pinned (which
		// still points at the old build after a failed install).
		restartOwnTui(
			{
				repoName,
				paneId: process.env['TMUX_PANE'] ?? '',
				command: installedLaunchCommand({
					execPath: process.execPath,
					cliPath: cliFilePath(),
					home: homedir(),
				}),
				paneLayout,
			},
			{
				...closeLayoutDeps,
				tmux: defaultServerTmuxRunner,
				repoStateRoot: DEFAULT_REPO_STATE_ROOT,
				print(line) {
					process.stdout.write(`\n${line}\n`);
				},
				waitForKey() {
					spawnSync('bash', ['-c', 'read -rsn1 _ </dev/tty 2>/dev/null'], {
						stdio: 'inherit',
					});
				},
			},
		);
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(0);
	}, [paneLayout, repoName, renderer]);

	// Tells `pappardelle restart` which build came up in this pane. Written on
	// first paint, after display metadata is available.
	useEffect(() => {
		const paneId = process.env['TMUX_PANE'];
		if (!initialPaneLayout || !paneId || !backgroundReady) return;
		try {
			clearDeadRestartLock(DEFAULT_REPO_STATE_ROOT, repoName);
			writeTuiMarker(DEFAULT_REPO_STATE_ROOT, repoName, {
				pid: process.pid,
				cliPath: cliFilePath(),
				sha: commitSha,
				paneId,
				startedAt: Date.now(),
			});
		} catch (error) {
			log.warn(
				'Failed to write the TUI ready marker',
				error instanceof Error ? error : undefined,
			);
		}
	}, [initialPaneLayout, repoName, commitSha, backgroundReady]);

	// Track if panes have been initialized
	const panesInitialized = useRef(false);

	// STA-1553: spaces whose teardown is in flight. The selection-change effect
	// must not reattach to (and thereby respawn the just-killed sessions of) a
	// space being closed. Cleared once the space leaves the list (effect below).
	const closingSpacesRef = useRef(new Set<string>());
	const closeTasks = useRef(new WorkspaceCloseTasks());
	const workspaceRefresh = useRef<WorkspaceRefresh | null>(null);

	const [paneDimensions, setPaneDimensions] = useState({
		rows: stdout?.rows ?? 40,
		cols: stdout?.columns ?? 80,
	});
	// Everything inside the rail's frame lays out in the space it leaves.
	const termDimensions = {
		rows: Math.max(1, paneDimensions.rows - PANE_FRAME_SIZE),
		cols: Math.max(1, paneDimensions.cols - PANE_FRAME_SIZE),
	};
	const [isRailFocused, setIsRailFocused] = useState(true);
	useEffect(() => {
		const focus = () => {
			setIsRailFocused(true);
		};

		const blur = () => {
			setIsRailFocused(false);
		};

		renderer.on('focus', focus);
		renderer.on('blur', blur);
		return () => {
			renderer.off('focus', focus);
			renderer.off('blur', blur);
		};
	}, [renderer]);

	const railDialogState = {
		showPromptDialog,
		showDeleteConfirm: deleteTarget !== null,
		killDoneTargets,
		showUpdateConfirm,
		showHelp,
		showErrorDialog,
		showConfigMigration: configMigrations !== null,
	};
	const railInputBlocked = isRailInputBlocked(railDialogState);

	// Calculate dimensions
	const termHeight = termDimensions.rows;

	const loadSpaces = useCallback(async () => {
		await workspaceRefresh.current?.refresh();
	}, []);

	const earlyWorkspaces = useRef(initialWorkspaces);
	useEffect(() => {
		const early = earlyWorkspaces.current;
		earlyWorkspaces.current = undefined;
		const refresh = new WorkspaceRefresh({
			detailReady: firstRailPaint,
			readRegistry: firstFrom(early?.registry, getRegisteredSpacesAsync),
			readStatus: async (key, sessionKey) =>
				workspaceStatuses.read(key, sessionKey),
			readWorktreePath: async key => getWorktreePathAsync(key, repoName),
			readMainWorktree: firstFrom(early?.mainWorktree, getMainWorktreeInfo),
			readDirty: isWorktreeDirty,
			statusKey: name => readableHookStatusKey(repoName, name),
			getCachedIssue: getIssueCached,
			fetchIssues: getIssues,
			async readEmoji(issueKey, cachedIssue) {
				return resolveSpaceEmojiAsync({
					config: configMemo,
					repoName,
					issueKey,
					cachedIssue,
				});
			},
			setSpaces,
			onLoaded: () => setLoading(false),
			onError: err =>
				log.error(
					'Failed to refresh workspaces',
					err instanceof Error ? err : undefined,
				),
		});
		workspaceRefresh.current = refresh;
		void refresh.refresh();
		const interval = setInterval(() => {
			void refresh.refresh();
		}, 10_000);
		return () => {
			clearInterval(interval);
			refresh.stop();
			workspaceRefresh.current = null;
		};
	}, [configMemo, repoName, setSpaces, workspaceStatuses, firstRailPaint]);

	// Warm the skill list once the rail has painted, so the first new-session
	// prompt can offer completions without waiting on a scan of its own.
	useEffect(() => {
		if (loading || !backgroundReady) return;
		const roots = skillRoots();
		if (roots) void skillSnapshot.refresh(roots);
	}, [loading, backgroundReady]);

	useEffect(
		() =>
			workspaceStatuses.watch(
				updates => workspaceRefresh.current?.applyStatusUpdates(updates),
				workspaceName => statusKeysRef.current.has(workspaceName),
			),
		[workspaceStatuses],
	);

	// Watch for cross-terminal highlight requests (pappardelle highlight STA-XXX)
	const focusSpaceAgentRef = useRef((_issueKey: string) => {});
	useEffect(() => {
		const unwatch = watchHighlightTarget(repoName, ({issueKey, focus}) => {
			clearHighlightTarget(repoName);
			if (focus) focusSpaceAgentRef.current(issueKey);
			else selectSpace(issueKey);
		});

		return unwatch;
	}, [repoName, selectSpace]);

	// Subscribe to error count for header badge
	useEffect(() => {
		const unsubscribe = subscribeToErrors(setRecentErrors);
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

	const startupQueue = useMemo(() => new StartupQueue(2), []);
	const attachmentTask = useMemo(() => new LatestTask(), []);
	const sendTask = useMemo(() => new LatestTask(), []);
	const attachmentGate = useMemo(() => new AttachmentGate(), []);
	const [attachmentRevision, setAttachmentRevision] = useState(0);
	useEffect(
		() => () => {
			startupQueue.stop();
			attachmentTask.cancel();
		},
		[startupQueue, attachmentTask],
	);

	const paneLayoutRef = useRef(paneLayout);
	paneLayoutRef.current = paneLayout;

	const listPaneId = paneLayout?.listPaneId;
	useEffect(() => {
		if (!listPaneId) return;
		void installSousChefKey(
			listPaneId,
			getSousChefKey(configMemo),
			highlightWriteCommand(repoName, {
				issueKey: MAIN_WORKTREE_KEY,
				focus: true,
			}),
		);
	}, [listPaneId, configMemo, repoName]);

	// Not undone on unmount: quitting unmounts App, and a signal arriving during
	// that teardown must still find a listener.
	useEffect(() => {
		const quit = () => {
			quitTui(renderer, repoName, paneLayoutRef.current);
		};

		quitOnCtrlC(renderer, quit);

		const paneId = process.env['TMUX_PANE'];
		let startedPid: string | undefined;
		if (paneId) {
			void panePid(paneId).then(pid => {
				startedPid = pid;
			});
		}

		quitOnSignals(() => {
			if (
				paneId &&
				startedPid &&
				paneRespawned(paneId, startedPid, closeLayoutDeps.layoutTmux)
			)
				renderer.destroy();
			else quit();
		});
	}, [renderer, repoName]);

	const dialogRequest = useRef({zoomed: railInputBlocked, revision: 0});
	if (dialogRequest.current.zoomed !== railInputBlocked) {
		dialogRequest.current = {
			zoomed: railInputBlocked,
			revision: dialogRequest.current.revision + 1,
		};
	}
	const [settledRevision, setSettledRevision] = useState<number | null>(null);
	const isZooming = Boolean(
		paneLayout && settledRevision !== dialogRequest.current.revision,
	);
	useEffect(() => {
		if (loading || isZooming || backgroundReady || !onFirstRailPaint) return;
		let fired = false;
		let timer: ReturnType<typeof setTimeout>;
		const afterFrame = () => {
			if (fired) return;
			fired = true;
			timer = setTimeout(onFirstRailPaint, 0);
		};
		renderer.addPostProcessFn(afterFrame);
		renderer.requestRender();
		return () => {
			renderer.removePostProcessFn(afterFrame);
			clearTimeout(timer);
		};
	}, [loading, isZooming, backgroundReady, onFirstRailPaint, renderer]);
	const syncingTerminalSize = useRef(false);
	const stackedLayoutRef = useRef(false);
	// Whether the most recent pane layout went through, for the ack a
	// `companion width` request waits on.
	const layoutSucceeded = useRef(true);
	const layoutTasks = useMemo(
		() =>
			new PaneLayoutTask({
				queue: attachmentTask,
				async apply(zoomed) {
					const layout = paneLayoutRef.current;
					if (!layout)
						return {rows: stdout?.rows ?? 40, cols: stdout?.columns ?? 80};
					const reconciled = await reconcilePaneLayout(layout, zoomed);
					stackedLayoutRef.current = reconciled.stacked;
					if (reconciled.layout !== layout) {
						paneLayoutRef.current = reconciled.layout;
						setPaneLayout(reconciled.layout);
						panesInitialized.current = false;
						// The new layout attaches the space again, splits included.
						takePendingSplitSync();
					} else if (!zoomed) {
						const viewing = getCurrentlyViewingSpace();
						if (takePendingSplitSync() && viewing)
							await syncCompanionSplits(layout, viewing);
					}
					return reconciled.dimensions;
				},
				onReady(_zoomed, dimensions, revision) {
					layoutSucceeded.current = true;
					syncingTerminalSize.current = true;
					try {
						if (stdout) syncTerminalDimensions(stdout, dimensions);
						renderer.resize(dimensions.cols, dimensions.rows);
					} finally {
						syncingTerminalSize.current = false;
					}
					setPaneDimensions(dimensions);
					setStackedLayout(stackedLayoutRef.current);
					setSettledRevision(revision);
				},
				onError(error, revision) {
					layoutSucceeded.current = false;
					log.error(
						'Failed to update pane layout',
						error instanceof Error ? error : undefined,
					);
					// Settle anyway: while unsettled, the list and any open dialog
					// render nothing and the dialog cannot take keys.
					setSettledRevision(revision);
				},
			}),
		[attachmentTask, stdout, renderer],
	);
	const dialogOpenRef = useRef(railInputBlocked);
	dialogOpenRef.current = railInputBlocked;
	useEffect(() => {
		if (paneLayoutRef.current) {
			const done = startupTrace.current?.begin('layout-request', {
				cause: 'state',
				loading,
				spaces: spaces.length,
				zoomed: railInputBlocked,
				revision: dialogRequest.current.revision,
			});
			void layoutTasks
				.request(railInputBlocked, dialogRequest.current.revision)
				.finally(() => done?.());
		}
	}, [layoutTasks, railInputBlocked, loading, spaces.length]);
	useEffect(() => () => layoutTasks.stop(), [layoutTasks]);
	useEffect(() => {
		if (!stdout) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const requestLayout = () => {
			if (!paneLayoutRef.current) return;
			const done = startupTrace.current?.begin('layout-request', {
				cause: 'resize',
				zoomed: dialogOpenRef.current,
				revision: dialogRequest.current.revision,
				cols: stdout.columns,
				rows: stdout.rows,
			});
			void layoutTasks
				.request(dialogOpenRef.current, dialogRequest.current.revision, () => ({
					cols: stdout.columns ?? 80,
					rows: stdout.rows ?? 40,
				}))
				.finally(() => done?.());
		};

		// A single resize, such as a tiling window manager making room for a
		// window, is laid out at once. The window can change again while that
		// layout runs without this pane's size changing, so no further event
		// arrives; laying out once more after a pause covers that and a drag.
		const handleResize = () => {
			setPaneDimensions({rows: stdout.rows ?? 40, cols: stdout.columns ?? 80});
			if (syncingTerminalSize.current) return;
			if (timer === undefined) requestLayout();
			clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				requestLayout();
			}, 150);
		};
		stdout.on('resize', handleResize);
		return () => {
			stdout.off('resize', handleResize);
			clearTimeout(timer);
		};
	}, [stdout, layoutTasks]);

	const selectedSpace = spaces[selectedIndex];
	const selectedSpaceName = selectedSpace?.name;
	// Read by the companion-width callbacks, which outlive the render they were
	// registered in.
	const selectedSpaceNameRef = useRef(selectedSpaceName);
	selectedSpaceNameRef.current = selectedSpaceName;
	const selectedWorktreePath = selectedSpace?.isMainWorktree
		? (selectedSpace.worktreePath ?? undefined)
		: undefined;
	const selectedIssueTitle =
		selectedSpace?.trackerIssue?.title ?? selectedSpace?.linearIssue?.title;

	// A space's own companion width applies only while that space is selected.
	const appliedSpaceWidth = useRef<string | null>(null);
	useEffect(() => {
		if (!selectedSpaceName) return;
		const width = getCompanionWidth(repoName, selectedSpaceName);
		const signature = width === null ? null : `${selectedSpaceName}=${width}`;
		setSpaceCompanionWidth(
			width === null ? null : {key: selectedSpaceName, width},
		);
		if (signature === appliedSpaceWidth.current) return;
		appliedSpaceWidth.current = signature;
		if (paneLayoutRef.current)
			void layoutTasks.request(
				dialogOpenRef.current,
				dialogRequest.current.revision,
			);
	}, [repoName, selectedSpaceName, layoutTasks]);

	useEffect(() => {
		setSpaceCompanionDragHandler((key, columns) => {
			if (key === selectedSpaceNameRef.current)
				appliedSpaceWidth.current = `${key}=${columns}`;
			setCompanionWidth(repoName, key, columns).catch((error: unknown) =>
				log.warn(
					`Failed to store the companion width for ${key}`,
					error instanceof Error ? error : undefined,
				),
			);
		});
		return () => setSpaceCompanionDragHandler(null);
	}, [repoName]);

	// Requests from `pappardelle companion width`. The CLI has already stored
	// the width; this applies it when the space is showing and says whether
	// the pane really took it.
	useEffect(() => {
		const handled = new Set<string>();
		const ack = (ackValue: Parameters<typeof writeLayoutAck>[1]) => {
			try {
				writeLayoutAck(repoName, ackValue);
			} catch (error) {
				log.warn(
					'Failed to answer a companion width request',
					error instanceof Error ? error : undefined,
				);
			}
		};

		return watchLayoutRequests(repoName, request => {
			if (handled.has(request.id)) return;
			handled.add(request.id);
			if (request.space !== selectedSpaceNameRef.current) {
				ack({id: request.id, result: 'stored'});
				return;
			}

			if (request.kind === 'layout') {
				void attachmentTask.exclusive(async () => {
					const layout = paneLayoutRef.current;
					if (!layout?.companionViewerPaneId) {
						ack({id: request.id, result: 'no-pane'});
						return;
					}

					try {
						const result = await syncCompanionSplits(layout, request.space);
						ack({id: request.id, result});
					} catch (error) {
						log.warn(
							`Failed to show the companion splits of ${request.space}`,
							error instanceof Error ? error : undefined,
						);
						ack({id: request.id, result: 'failed'});
					}
				});
				return;
			}

			// Set even when nothing can show it yet, so the next layout of this
			// space (a wider window, a closed dialog) uses the new width.
			const width = getCompanionWidth(repoName, request.space);
			setSpaceCompanionWidth(
				width === null ? null : {key: request.space, width},
			);
			appliedSpaceWidth.current =
				width === null ? null : `${request.space}=${width}`;
			if (!paneLayoutRef.current?.companionViewerPaneId) {
				ack({id: request.id, result: 'no-pane'});
				return;
			}

			// An open dialog zooms the rail, and the layout under it waits until
			// the dialog closes.
			if (dialogOpenRef.current) {
				ack({id: request.id, result: 'deferred'});
				return;
			}

			void (async () => {
				await layoutTasks.request(
					dialogOpenRef.current,
					dialogRequest.current.revision,
				);
				// The layout may have been rebuilt with new pane ids.
				const layout = paneLayoutRef.current;
				if (!layout?.companionViewerPaneId) {
					ack({id: request.id, result: 'no-pane'});
					return;
				}

				const columns = layoutSucceeded.current
					? await measureCompanionColumnWidth(layout).catch(() => null)
					: null;
				ack(
					columns === null
						? {id: request.id, result: 'failed'}
						: {id: request.id, result: 'applied', columns},
				);
			})();
		});
	}, [repoName, layoutTasks, attachmentTask]);

	useEffect(() => {
		if (
			!paneLayout ||
			!selectedSpaceName ||
			closingSpacesRef.current.has(selectedSpaceName) ||
			(selectedSpace?.isMainWorktree && !selectedWorktreePath)
		)
			return;
		const queued = startupTrace.current?.begin('attachment-queue');
		void attachmentTask
			.run(async signal => {
				queued?.();
				if (closingSpacesRef.current.has(selectedSpaceName)) return;
				const registered = await getRegisteredSpacesAsync().catch(() => null);
				if (signal.aborted) return;
				if (
					!shouldAttach(
						{
							name: selectedSpaceName,
							isMainWorktree: selectedSpace?.isMainWorktree,
							isPending: selectedSpace?.isPending,
						},
						registered,
					)
				) {
					void workspaceRefresh.current?.refreshListOnly();
					return;
				}

				const layout = paneLayoutRef.current;
				if (!layout) return;
				const success = await attachToSpace(
					layout.agentViewerPaneId,
					layout.companionViewerPaneId,
					selectedSpaceName,
					layout.listPaneId,
					selectedWorktreePath,
					selectedIssueTitle,
					{signal},
				);
				if (success && !signal.aborted) {
					panesInitialized.current = true;
					startupTrace.current?.attachmentReady();
				}
			})
			.catch((err: unknown) =>
				log.error(
					'Failed to attach workspace',
					err instanceof Error ? err : undefined,
				),
			);
		return () => {
			queued?.('cancelled');
			attachmentTask.cancel();
		};
	}, [
		selectedSpaceName,
		selectedWorktreePath,
		selectedSpace?.isMainWorktree,
		selectedSpace?.isPending,
		selectedIssueTitle,
		paneLayout,
		attachmentTask,
		attachmentRevision,
	]);
	// Declared after the attachment effect so it runs after any attachment
	// this render queued. Every render releases waiting keys: one whose space
	// was left again in the same input write is then refused, not kept.
	useEffect(() => {
		attachmentGate.rendered(selectedSpaceName);
	});
	// Every key in one input write runs before React renders, so keys after one
	// that opened an inline dialog would still act on the rail.
	// They are dropped until that dialog is on screen to take them.
	const inlineDialogOpening = useRef(false);
	useEffect(() => {
		inlineDialogOpening.current = false;
	});

	// Initialize panes with empty state message on first load
	useEffect(() => {
		if (!paneLayout) return;
		if (panesInitialized.current) return;
		if (loading) return;

		if (spaces.length === 0) {
			displayMessageInPane(
				paneLayout.agentViewerPaneId,
				'No spaces found. Press n to create a new space.',
			);
			// Only clear companion pane if it exists (may not on narrow screens)
			if (paneLayout.companionViewerPaneId) {
				displayMessageInPane(paneLayout.companionViewerPaneId, '');
			}
			panesInitialized.current = true;
		}
	}, [paneLayout, spaces, loading]);

	// Open the GitHub PR / GitLab MR in browser for the selected space
	// For main worktree, opens the repo page instead
	const handleOpenPR = () => {
		const space = selectedSpaceNow();
		if (!space || space.isPending) return;

		if (space.isMainWorktree) {
			++openPRRequest.current;
			const generation = showHeaderMessage('Opening repo...');
			const child = spawn('gh', ['repo', 'view', '--web'], {
				detached: true,
				stdio: 'ignore',
			});
			child.on('error', err => {
				log.error(`Failed to launch gh: ${err.message}`, err);
				if (headerGeneration.current === generation) {
					setHeaderWithTimeout('Could not launch gh', 3000);
				}
			});
			child.on('spawn', () => {
				if (headerGeneration.current === generation) {
					setHeaderWithTimeout('Opened repo', 3000);
				}
			});
			child.unref();
			return;
		}

		const request = ++openPRRequest.current;
		const generation = showHeaderMessage(`Opening PR for ${space.name}...`);
		void openPR(space.name, {
			provider: createVcsHost(),
			// link-pr appends, so the last link is the one recorded most recently.
			linked: readSpaceState(repoName, space.name)?.prLinks?.at(-1),
			isLatest: () => openPRRequest.current === request,
			ownsHeader: () => headerGeneration.current === generation,
			async openUrl(url) {
				const child = spawn('open', [url], {
					detached: true,
					stdio: 'ignore',
				});
				child.on('error', err => {
					log.error(`Failed to launch open: ${err.message}`, err);
				});
				await once(child, 'spawn');
				child.unref();
			},
			showMessage: message => setHeaderWithTimeout(message, 3000),
		});
	};

	// Open the issue for the selected space — in a browser for trackers with a
	// web UI, in a tmux popup for local-only ones (beads).
	const handleOpenIssue = () => {
		const space = selectedSpaceNow();
		if (!space || space.isPending || space.isMainWorktree) {
			if (space?.isMainWorktree)
				setHeaderWithTimeout('No issue for main worktree', 2000);
			return;
		}

		void openIssueForKey(space.name).then(result => {
			setHeaderWithTimeout(result.message, 3000);
		});
	};

	// Open the configured editor at the worktree path for the selected space
	const handleOpenIDE = () => {
		const space = selectedSpaceNow();
		if (!space || space.isPending) return;

		const {worktreePath} = space;
		if (!worktreePath) {
			setHeaderWithTimeout('No worktree path found', 2000);
			return;
		}

		const profileName = resolveSpaceProfileName({
			config: configMemo,
			repoName,
			issueKey: space.name,
			cachedIssue: space.trackerIssue ?? space.linearIssue ?? null,
		});
		const command = configMemo
			? getIdeCommand(configMemo, profileName)
			: DEFAULT_IDE_COMMAND;

		// An empty ide_command is the documented way to turn the key off.
		if (command.trim() === '') {
			setHeaderWithTimeout('No ide_command configured', 2000);
			return;
		}

		const vars = buildWorkspaceTemplateVars(
			space.name,
			worktreePath,
			space.trackerIssue?.title ?? space.linearIssue?.title,
			configMemo ?? undefined,
			profileName,
		);

		const launchId = ++ideLaunchCounter.current;
		// Unlike every other command template, the vars are not expandTemplate'd
		// in: bash expands them from the environment after parsing, so a worktree
		// path containing `$(...)` cannot run as the user.
		const child = spawn('bash', ['-c', command], {
			cwd: worktreePath,
			detached: true,
			stdio: 'ignore',
			env: {...process.env, ...vars},
		});

		// A GUI editor can exit long after launch, so failures are reported by
		// launch identity instead of a time window: always log, but only touch
		// the header while this launch is still the most recent one.
		const reportFailure = (detail: string) => {
			log.error(`ide_command failed for ${space.name}: ${command} (${detail})`);
			if (ideLaunchCounter.current === launchId) {
				setHeaderWithTimeout(`✗ IDE: ${detail}`, 5000);
			}
		};

		child.on('error', err => {
			reportFailure(err.message.slice(0, IDE_ERROR_HEADER_CHARS));
		});
		child.on('close', code => {
			if (code !== 0) reportFailure(`exit ${code}`);
		});

		child.unref();
		setHeaderWithTimeout(`Opening IDE for ${space.name}`, 3000);
	};

	// Focus the Claude viewer pane (Enter or right arrow)
	const handleFocusAgent = () => {
		const targetSpace = selectedSpaceNow()?.name;
		if (!paneLayout || !targetSpace) return;

		// Attaching ends by selecting the rail pane, so focus goes after it.
		void attachmentGate.whenRendered(targetSpace).then(async () =>
			attachmentTask.exclusive(async () => {
				const layout = paneLayoutRef.current;
				if (layout) await focusPane(layout.agentViewerPaneId);
			}),
		);
	};

	// While a dialog or prompt is open, the rail owns the keyboard.
	const railInputBlockedNow = () =>
		dialogOpenRef.current ||
		popupOpening.current ||
		inlineDialogOpening.current;

	// Selects a space and focuses its agent, as the sous-chef key and `s` do.
	const focusSpaceAgent = (issueKey: string) => {
		// Moving focus away would leave the dialog open with the user's next
		// keys going to the agent.
		if (railInputBlockedNow()) return;
		selectSpace(issueKey);
		const {spaces, selectedIndex} = currentSelection();
		// Before the rows load, or for an unknown key, the selection stays put
		// and focusing would land on another space's agent.
		if (findSpaceIndexByIssueKey(spaces, issueKey) === selectedIndex)
			handleFocusAgent();
	};

	focusSpaceAgentRef.current = focusSpaceAgent;

	// Git pull in the selected space's worktree
	const handleGitPull = () => {
		const space = selectedSpaceNow();
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
		showHeaderMessage('Pulling...');

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

	// Send text to the agent pane for the selected workspace
	const handleSendToAgent = (text: string) => {
		if (!paneLayout) {
			setHeaderWithTimeout('No pane layout available', 2000);
			return;
		}

		const targetSpace = selectedSpaceNow()?.name;
		if (!targetSpace) return;
		void attachmentGate
			.whenRendered(targetSpace)
			.then(async () =>
				sendToSelectedAgent({
					queue: attachmentTask,
					sends: sendTask,
					targetSpace,
					viewingSpace: getCurrentlyViewingSpace,
					// Not through the viewer pane: its frame process holds a bracketed
					// paste briefly while plain keys pass, so Enter would arrive first.
					async send() {
						const result = await sendToSpaceAgent(targetSpace, text);
						recordSupervision(
							repoName,
							'tui',
							{action: 'send', key: targetSpace, sent: text, detail: result},
							new Date(),
						);
						if (result !== 'sent') {
							log.error(`Send to ${targetSpace}'s agent session: ${result}`);
						}

						return result;
					},
				}),
			)
			.then(result => {
				setHeaderWithTimeout(
					sendResultMessage(result, targetSpace, text),
					3000,
				);
			});
	};

	// Execute a custom keybinding command for the selected workspace
	const handleCustomKeybinding = (kb: KeybindingConfig) => {
		if (kb.send_to_claude) {
			handleSendToAgent(kb.send_to_claude);
			return;
		}

		const space = selectedSpaceNow();
		if (kb.send_skill) {
			if (!space || !configMemo) return;
			const agentProfile = runningAgentProfile(
				configMemo,
				space.name,
				space.trackerIssue?.title ?? space.linearIssue?.title,
			);
			// The name opens codex's skill picker, even when pasted, and Enter in
			// the picker only inserts the skill. A space ends the name and closes
			// the picker.
			handleSendToAgent(`${agentProfile.skillPrefix}${kb.send_skill} `);
			return;
		}

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
		showHeaderMessage(`Running: ${kb.name}...`);

		// Build template vars and expand the command
		const vars = buildWorkspaceTemplateVars(
			space.name,
			worktreePath,
			space.trackerIssue?.title ?? space.linearIssue?.title,
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

	// Only one popup at a time, and "at a time" lasts until its action has
	// finished: a close confirmed in a popup keeps running its deinit hooks
	// after the popup is gone, and a second x must not start another.
	const popupBusy = useRef(false);
	// Keys typed right after a popup opener (`x Enter`, `x n`) still reach the
	// rail until the popup is on screen, and would act behind the dialog.
	const popupOpening = useRef(false);
	const showDialog = (
		spec: PopupSpec,
		handlers: PopupHandlers,
		showInline: () => void,
	) => {
		const openInline = () => {
			inlineDialogOpening.current = true;
			showInline();
		};

		if (!isPopupAvailable()) {
			openInline();
			return;
		}

		if (popupBusy.current) {
			setHeaderWithTimeout('Still working on the last dialog', 2000);
			return;
		}

		popupBusy.current = true;
		popupOpening.current = true;
		void openPopup(spec, {
			...handlers,
			onShown() {
				popupOpening.current = false;
			},
		})
			.then(outcome => {
				if (outcome === 'unavailable') openInline();
			})
			.finally(() => {
				popupBusy.current = false;
				popupOpening.current = false;
			});
	};

	// Opened straight through openPopup: it follows the rewrite confirm, whose
	// popup has already closed but still counts as busy until its action ends.
	const offerConfigFix = (reason: string) => {
		const warning = `Config not rewritten: ${reason}`;
		log.warn(warning);
		if (!isPopupAvailable()) return;
		openPopup(
			{kind: 'confirm', props: buildConfigFixConfirmContent(reason)},
			{
				closeBeforeConfirm: true,
				async onConfirm() {
					// Read from a file: tmux refuses a command line over about
					// 16KB, which a config with many deprecated keys reaches.
					const dir = fs.mkdtempSync(
						path.join(tmpdir(), 'pappardelle-config-fix-'),
					);
					const promptFile = path.join(dir, 'prompt.md');
					fs.writeFileSync(promptFile, buildConfigFixPrompt(reason));
					try {
						// --add-dir: the home config sits outside the repo, where
						// claude would otherwise ask before every edit.
						const exitCode = await runCommandPopup(
							`claude --add-dir ${shellQuote(getDefaultHomeConfigDir())} "$(cat ${shellQuote(promptFile)})"`,
							{cwd: process.cwd(), title: ' Fix pappardelle config '},
						);
						if (exitCode !== 0) {
							log.warn(`claude for the config fix exited with ${exitCode}`);
						}
					} finally {
						fs.rmSync(dir, {recursive: true, force: true});
					}

					if (dismissResolvedDeprecationWarnings()) {
						dismissRecentErrors(entry => entry.message === warning);
					}
				},
			},
		).catch((error: unknown) => {
			log.error(
				'Config fix offer failed',
				error instanceof Error ? error : undefined,
			);
		});
	};

	const handleConfigMigration = (approved: ConfigMigration[]) => {
		const outcome = confirmConfigMigrations(
			approved,
			getSpaceStateDir(repoName),
		);
		switch (outcome.kind) {
			case 'rewritten': {
				setHeaderWithTimeout('Config rewritten', 4000);
				break;
			}

			case 'changed': {
				setHeaderWithTimeout('Config changed; not rewritten', 4000);
				break;
			}

			case 'failed': {
				setHeaderWithTimeout('Config rewrite failed', 4000);
				offerConfigFix(outcome.reason);
				break;
			}
		}
	};

	// Offered once per launch; declining leaves the config and its warnings as
	// they are until the next start.
	useEffect(() => {
		const plan = planConfigMigrations();
		if (plan.kind === 'unsupported') offerConfigFix(plan.reason);
		if (plan.kind !== 'ready') return;
		const {migrations} = plan;
		showDialog(
			{
				kind: 'confirm',
				props: buildConfigMigrationConfirmContent(migrations),
			},
			{
				closeBeforeConfirm: true,
				onConfirm() {
					handleConfigMigration(migrations);
				},
			},
			() => {
				setConfigMigrations(migrations);
			},
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Returns whether search took the key.
	const handleSearchKey = (event: KeyEvent): boolean => {
		const {current} = searchNow;
		if (!current) return false;
		const step = searchKeyStep(
			current,
			displaySpacesRef.current,
			shortcutKey(event),
			searchInputDrawn.current,
		);
		if (step.select) selectSpace(step.select);
		updateSearch(step.search);
		return true;
	};

	// Handle keyboard input
	useKeyboard(event => {
		if (handleSearchKey(event)) return;
		if (railInputBlockedNow()) return;
		const {input, key} = shortcutKey(event);

		// Check custom keybindings first — they can override default keys
		const kb = keybindingMap.get(input);
		if (kb) {
			if (!kb.disabled) {
				handleCustomKeybinding(kb);
			}
			return;
		}

		const rail = railNow();
		if (rail && rail.rows.length > 0) {
			const {rows, cursor} = rail;
			const step =
				key.upArrow || input === 'k'
					? -1
					: key.downArrow || input === 'j'
						? 1
						: 0;
			if (step !== 0) {
				const row = rows[nextSelectableRow(rows, cursor, step)];
				if (row?.kind === 'space') selectSpace(row.space.name);
				return;
			}
		}

		// Non-overridable built-in shortcuts
		if (key.upArrow || input === 'k') {
			const {selectedIndex} = currentSelection();
			if (selectedIndex > 0) {
				setSelectedIndex(selectedIndex - 1);
			}
		} else if (key.downArrow || input === 'j') {
			const {spaces, selectedIndex} = currentSelection();
			if (selectedIndex < spaces.length - 1) {
				setSelectedIndex(selectedIndex + 1);
			}
		} else if (isFocusAgentKey(key)) {
			handleFocusAgent();
		} else if (input === 'n') {
			if (hasNoProfiles()) {
				setHeaderWithTimeout(
					'Add a profile to .pappardelle.yml to create spaces',
					4000,
				);
			} else {
				inlineDialogOpening.current = true;
				setShowPromptDialog(true);
			}
		} else if (isCloseSpaceKey(input, key)) {
			// Backspace, Delete, or 'x' closes the selected space
			const space = selectedSpaceNow();
			if (space?.isMainWorktree) {
				setHeaderWithTimeout('Cannot close main worktree', 2000);
			} else if (space) {
				showDialog(
					{
						kind: 'close-space',
						props: {
							spaceName: space.name,
							currentIssue: space.trackerIssue ?? space.linearIssue ?? null,
						},
					},
					{
						onConfirm: async payload =>
							handleDeleteSpace(space, payload?.choice),
					},
					() => {
						setDeleteTarget(space);
					},
				);
			}
		} else if (input === 'K') {
			// Shift+K closes every done/canceled space at once (STA-2111).
			// Checked before the switch below so it can't be shadowed by the
			// lowercase `k` navigation branch above.
			const targets = findDoneSpaces(currentSelection().spaces);
			if (targets.length === 0) {
				setHeaderWithTimeout(KILL_DONE_EMPTY_MESSAGE, 2000);
			} else {
				showDialog(
					{
						kind: 'confirm',
						props: buildKillDoneConfirmContent(targets.length),
					},
					{onConfirm: async () => handleKillDoneSpaces(targets)},
					() => {
						setKillDoneTargets(targets);
					},
				);
			}
		} else
			switch (input) {
				case '/': {
					setSearchSession(session => session + 1);
					updateSearch({query: '', index: 0});
					break;
				}
				case 'q': {
					quitTui(renderer, repoName, paneLayout);
					break;
				}
				case '?': {
					// Show help overlay
					showDialog(
						{
							kind: 'help',
							props: {
								customKeybindings: keybindings,
								commitSha,
								installedVersion,
								isDevBuild,
							},
						},
						{},
						() => {
							setShowHelp(true);
						},
					);

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
						showDialog(
							{kind: 'errors', props: {errors: getRecentErrors()}},
							{
								onClearErrors: clearRecentErrors,
								subscribeErrors: subscribeToErrors,
							},
							() => {
								setShowErrorDialog(true);
							},
						);
					}

					break;
				}
				case 'p': {
					handleGitPull();

					break;
				}
				case 's': {
					focusSpaceAgent(MAIN_WORKTREE_KEY);

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
						showDialog(
							{kind: 'confirm', props: updateConfirmContent},
							{
								closeBeforeConfirm: true,
								onConfirm: handleUpdateConfirmed,
							},
							() => {
								setShowUpdateConfirm(true);
							},
						);
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
	});

	const spawnSession = useCallback(
		(pending: PendingSession, options?: {queued: boolean}) => {
			// Show the pending row now, not when a queue slot frees up, so the
			// user sees the start at once (as on main).
			setPendingSession(pending);
			void scheduleWorkspaceStart(
				startupQueue,
				async () => {
					if (pending.name && pending.inputIsIssueKey)
						claimIssueInBackground(pending.name);
					log.info(`Starting idow for pending session: ${pending.name}`);
					const result = await runWorkspaceSetup(
						path.join(SCRIPTS_DIR, 'idow'),
						buildNewSessionArgs(pending.idowArg, {
							profileName: pending.profileName,
							agentProfileName: pending.agentProfileName,
							inputIsIssueKey: pending.inputIsIssueKey,
						}),
						{
							cwd: getRepoRoot(),
							env: buildSpawnEnv(getRepoRoot(), getMainRepoRoot()),
						},
					);
					if (result.code !== 0) {
						throw new Error(
							result.stderr.trim() ||
								result.stdout.match(/Error: .*/)?.[0] ||
								`idow exited with ${result.signal ?? `code ${result.code}`}`,
						);
					}
					// Description routes only acquire an issue key once idow creates it.
					const spaceKey =
						pending.name || extractIssueKeyFromIdowOutput(result.stdout);
					if (spaceKey && !pending.name) claimIssueInBackground(spaceKey);
					if (spaceKey) await addSpace(spaceKey);
					if (
						pending.agentProfileName &&
						idowSkippedAgentOverride(result.stdout)
					) {
						setHeaderWithTimeout(
							`Agent already running; ${pending.agentProfileName} not applied`,
							5000,
						);
					}

					await loadSpaces();
				},
				options ?? {queued: false},
			)
				.finally(async () => {
					if (!pending.watchlistSource) return;
					// A stale reservation only delays the next watchlist spawn; it must
					// not report a workspace that did start as failed.
					await releaseWatchlistReservation(pending.name).catch(
						(err: unknown) => {
							log.warn(
								`Failed to release watchlist reservation for ${pending.name}`,
								err instanceof Error ? err : undefined,
							);
						},
					);
				})
				.catch((err: unknown) => {
					setPendingSession(current => (current === pending ? null : current));
					const error = err instanceof Error ? err : new Error(String(err));
					log.error('Failed to start workspace', error);
					setHeaderWithTimeout(`Failed: ${error.message.slice(0, 40)}`, 5000);
				});
		},
		[startupQueue, loadSpaces, setHeaderWithTimeout],
	);

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
		const pollAbort = new AbortController();

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
					pollAbort.signal.throwIfAborted();

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

					// Skip issues we already attempted to spawn (e.g. one that also
					// matched another watchlist this cycle, or a prior one). First
					// match wins by iteration order — the top-level watchlist
					// precedes profile watchlists (see getResolvedWatchlists), so on
					// the rare overlap (a profile watching the same status as the
					// top-level) the issue keeps the top-level's no-profile spawn.
					const unclaimed = newIssues.filter(issue => {
						if (
							!watchlistSpawnedRef.current.has(issue.identifier.toUpperCase())
						) {
							return true;
						}

						log.debug(
							`Watchlist (${source}): ${issue.identifier} already claimed by this or another watchlist or instance — skipping`,
						);
						return false;
					});

					const max = watchlist.max_workspaces;
					const sourceId = watchlistSourceId(profileName);
					let toSpawn = unclaimed;
					if (max !== undefined && unclaimed.length > 0) {
						// Capacity is checked under the shared registry lock.
						const sorted = sortIssuesByCreatedAt(unclaimed);
						const {reserved, occupied, claimedElsewhere} =
							await tryReserveWatchlistSlots(
								sourceId,
								sorted.map(issue => issue.identifier),
								max,
								{signal: pollAbort.signal},
							);
						if (pollAbort.signal.aborted) {
							await Promise.all(
								reserved.map(async key => releaseWatchlistReservation(key)),
							);
							return;
						}
						// Another instance or watchlist is spawning these. Claim them
						// here too, or this instance would respawn one as soon as its
						// owner's workspace is closed.
						for (const key of claimedElsewhere) {
							watchlistSpawnedRef.current.add(key.toUpperCase());
						}

						const reservedSet = new Set(reserved);
						const claimedSet = new Set(claimedElsewhere);
						toSpawn = sorted.filter(issue => reservedSet.has(issue.identifier));
						// Deferred issues stay unclaimed, so a later watchlist that also
						// matches may spawn them, and this one retries next poll.
						const deferred = sorted.filter(
							issue =>
								!reservedSet.has(issue.identifier) &&
								!claimedSet.has(issue.identifier),
						);
						if (deferred.length > 0) {
							log.info(
								`Watchlist (${source}): ${occupied + reserved.length}/${max} slots in use, deferring ${deferred.length} issue(s): ${deferred.map(issue => issue.identifier).join(', ')}`,
							);
						}
					}

					for (const issue of toSpawn) {
						watchlistSpawnedRef.current.add(issue.identifier.toUpperCase());
						log.info(
							`Watchlist (${source}): spawning workspace for ${issue.identifier} (${issue.title})`,
						);

						spawnSession(
							{
								type: 'issue',
								name: issue.identifier,
								idowArg: issue.identifier,
								inputIsIssueKey: true,
								pendingTitle: `Watchlist: ${issue.title}`,
								prevSpaceCount: spacesLengthRef.current,
								// Force the owning profile so idow runs the right
								// profile-specific setup and the pending row shows its
								// emoji. null (top-level watchlist) keeps the legacy
								// behavior: no --profile, idow resolves by project.
								profileName: profileName ?? undefined,
								profileEmoji: resolvePendingProfileEmoji(
									configMemo,
									profileName,
								),
								watchlistSource: max === undefined ? undefined : sourceId,
							},
							{queued: true},
						);
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
			pollAbort.abort();
			clearTimeout(initialTimer);
			clearInterval(interval);
		};
	}, [watchlists, configMemo, spawnSession]);

	// Tear down a single space: run pre_workspace_deinit hooks, kill its tmux
	// sessions, remove it from the persisted registry, clear the viewer
	// panes if it was current, and optimistically prune it from local state.
	// Returns true on success, false if deinit aborted the removal.
	//
	// Shared by the user-pressed-`d` flow (handleDeleteSpace) and the
	// auto-remove-on-done flow.
	const performDeleteSpace = useCallback(
		async (space: SpaceData): Promise<boolean> => {
			const deinit = await runCloseHooks({
				name: space.name,
				worktreePath: space.worktreePath,
				trackerIssue: space.trackerIssue ?? space.linearIssue,
			});
			if (!deinit.success) {
				setHeaderWithTimeout(
					`Deinit failed: ${deinit.failedCommand ?? 'unknown'} — deletion aborted`,
					5000,
				);
				return false;
			}

			// Prevent reattachment until the deleted space has left the list.
			closingSpacesRef.current.add(space.name);
			if (selectedSpaceNow()?.name === space.name) attachmentTask.cancel();
			return attachmentTask
				.exclusive(async () => {
					// STA-1420: kill tmux first, then update the registry. If the kill
					// fails (tmux hiccup, socket gone, race), leave the registry alone
					// so the user can retry — otherwise it advertises "closed" while
					// the inner-socket session is still alive, and post-STA-1416 there
					// is no `seedFromTmux` reaper to recover from that mismatch.
					const tornDown = await tearDownSpace(space.name, {
						killSpaceSessions,
						async removeSpace(key) {
							await removeSpace(key);
							void workspaceRefresh.current?.refreshListOnly();
						},
						async cleanup(key) {
							removeProgramSnapshots(repoName, key);
							return deleteQaSimulator(key);
						},
						onKillFailure: key =>
							setHeaderWithTimeout(
								`Failed to kill tmux sessions for ${key} — try again`,
								5000,
							),
					});
					if (!tornDown) {
						// Kill failed — the space stays open, so stop guarding it or its
						// legitimate reattach would be blocked forever.
						closingSpacesRef.current.delete(space.name);
						setAttachmentRevision(revision => revision + 1);
						return false;
					}

					const layout = paneLayoutRef.current;
					if (layout && selectedSpaceNow()?.name === space.name) {
						await closeCompanionSplitPanes();
						await Promise.all([
							displayMessageInPaneAsync(
								layout.agentViewerPaneId,
								'Session closed',
							),
							displayMessageInPaneAsync(
								layout.companionViewerPaneId,
								'Session closed',
							),
						]);
					}

					// Optimistically prune from local state so the reattach useEffect
					// never sees the deleted space (loadSpaces is async, so relying on
					// it alone leaves a window where attachToSpace would respawn the
					// killed session). The closingSpacesRef guard above covers the same
					// window belt-and-suspenders, in case these state updates don't batch.
					setSpaces(prev => prev.filter(s => s.name !== space.name));
					return true;
				})
				.catch((err: unknown) => {
					closingSpacesRef.current.delete(space.name);
					setAttachmentRevision(revision => revision + 1);
					log.error(
						`Failed to close ${space.name}`,
						err instanceof Error ? err : undefined,
					);
					return false;
				});
		},
		[
			setHeaderWithTimeout,
			attachmentTask,
			setSpaces,
			repoName,
			selectedSpaceNow,
		],
	);

	const deleteSpace = useCallback(
		async (space: SpaceData): Promise<boolean> =>
			closeTasks.current.run(space.name, async () => {
				if (closingSpacesRef.current.has(space.name)) return true;
				return performDeleteSpace(space);
			}),
		[performDeleteSpace],
	);

	// STA-1553: once a closed space has actually left the list, drop its closing
	// tombstone. Tying cleanup to the space leaving `spaces` (rather than a timer)
	// keeps the guard active for exactly the respawn-prone window, while ensuring
	// a later genuine re-open of the same key isn't blocked.
	useEffect(() => {
		if (closingSpacesRef.current.size === 0) return;
		const live = new Set(spaces.map(s => s.name));
		for (const key of closingSpacesRef.current) {
			if (!live.has(key)) closingSpacesRef.current.delete(key);
		}
	}, [spaces]);

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
				})
				.finally(() => {
					autoRemoveInFlightRef.current.delete(space.name);
				});
		}
	}, [spaces, configMemo, deleteSpace, setHeaderWithTimeout]);

	const vcs = useMemo(() => createVcsHost(), []);
	const hasRailTargets = spaces.some(
		s => !s.isMainWorktree && !s.isPending && s.name.length > 0,
	);
	useRailStatusPolling(hasRailTargets && backgroundReady, async () => {
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
			const lookup = await vcs.getBulkRailStatus(
				targets.map(t => t.name),
				new Map(
					targets
						.filter(t => t.worktreePath)
						.map(t => [t.name, t.worktreePath!]),
				),
			);

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
			// Transcript reads yield to input; unchanged files reuse cached recaps.
			const repoName = getRepoName();
			for (const [name, rail] of lookup) {
				const worktreePath = getWorktreePath(name);
				const jsonl = worktreePath
					? await findLatestSessionJsonl(worktreePath)
					: null;
				const recap = jsonl ? await extractRecapFromJsonl(jsonl) : null;
				writeSpaceState(repoName, name, {
					pipeline: rail.pipeline,
					unresolvedCommentCount: rail.unresolvedCommentCount,
					prNumber: rail.prNumber,
					hasConflict: rail.hasConflict ?? false,
					...(recap ? {recap} : {}),
				});
			}
		} catch (err) {
			log.warn(
				'Rail status poll failed',
				err instanceof Error ? err : undefined,
			);
		}
	});

	// Open workspace apps/links/etc for the selected space (runs idow --resume)
	const handleOpenWorkspace = () => {
		const space = selectedSpaceNow();
		if (!space) return;
		if (space.isPending) return;
		if (space.isMainWorktree) {
			setHeaderWithTimeout('Cannot open main worktree', 2000);
			return;
		}

		showHeaderMessage(`Opening ${space.name}...`);

		const child = spawnQuietCommand(
			path.join(SCRIPTS_DIR, 'idow'),
			buildOpenWorkspaceArgs(space.name),
			{
				detached: true,
				cwd: getRepoRoot(),
				env: buildSpawnEnv(getRepoRoot(), getMainRepoRoot()),
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
	const handleNewSession = (
		input: string,
		profileName: string | null,
		inputIsIssueKey: boolean,
		agentProfileName: string | null,
	) => {
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
		const normalizedIssueKey = inputIsIssueKey
			? input.trim()
			: normalizeIssueIdentifier(
					input,
					teamPrefix,
					createIssueTracker().name,
					config ? getBeadsPrefixes(config, readBeadsIssuePrefix()) : [],
				);

		// Route the session: always pass just the issue key (or description) to idow.
		// idow handles both new and existing issues correctly with a bare issue key.
		const route = routeSession(normalizedIssueKey);
		const pending: PendingSession = {
			type: route.type,
			name: route.issueKey ?? '',
			idowArg: route.issueKey ?? input,
			inputIsIssueKey,
			pendingTitle: route.pendingTitle,
			// Read through the ref: a popup submits through the closure captured
			// when `n` was pressed, and the list can change while it is open.
			prevSpaceCount: spacesRef.current.length,
			profileName,
			agentProfileName,
			profileEmoji: resolvePendingProfileEmoji(config, profileName),
		};
		spawnSession(pending);
	};

	const writeIssueState = async (space: SpaceData, choice: StateChoice) => {
		let written = false;
		try {
			written = await applyStateChoice(
				createIssueTracker(),
				space.name,
				choice,
			);
		} catch (error) {
			log.warn(
				`Failed to set ${space.name}'s issue state`,
				error instanceof Error ? error : undefined,
			);
		}

		if (!written) {
			setHeaderWithTimeout(
				`Closed ${space.name}, but could not set its issue to ${choiceLabel(choice)}`,
				5000,
			);
		}
	};

	// Handle user-triggered space deletion (the `x` key with confirm dialog).
	// STA-1373: keep the dialog mounted across the await so it can render its
	// "Closing space…" loading state — the pre_workspace_deinit hooks can run
	// for several seconds, and hiding the dialog up front made the TUI look
	// frozen. The issue-state write runs after the dialog closes: `bd close`
	// can take seconds after the row has already left the rail.
	const handleDeleteSpace = async (space: SpaceData, choice?: StateChoice) => {
		try {
			const ok = await deleteSpace(space);
			if (!ok) return;

			if (choice) void writeIssueState(space, choice);

			// Reconcile with tmux reality in the background
			loadSpaces();
		} finally {
			setDeleteTarget(null);
		}
	};

	// Close every done/canceled space in one pass (the `K` shortcut, STA-2111).
	// Runs sequentially rather than in parallel: each deleteSpace shells out to
	// the user's pre_workspace_deinit hooks, and firing a dozen of those at once
	// would fight over the same git worktree lock and flood the tracker API.
	const handleKillDoneSpaces = async (targets: SpaceData[]) => {
		try {
			let closed = 0;
			for (const space of targets) {
				const ok = await deleteSpace(space);
				if (ok) closed++;
			}

			setHeaderWithTimeout(formatKillDoneResult(closed, targets.length), 4000);

			// Reconcile with tmux reality in the background
			loadSpaces();
		} finally {
			setKillDoneTargets(null);
		}
	};

	const killDoneConfirmContent = buildKillDoneConfirmContent(
		killDoneTargets?.length ?? 0,
	);

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
			const result = [...spaces];
			let insertIdx = result.findIndex(
				s =>
					!s.isMainWorktree &&
					compareSpaceNames(pendingSession.name, s.name) < 0,
			);
			if (insertIdx === -1) {
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

	displaySpacesRef.current = displaySpaces;

	const searchQuery = search?.query ?? '';
	const filteredDisplaySpaces = useMemo(
		() => filterSpaces(displaySpaces, searchQuery),
		[displaySpaces, searchQuery],
	);
	const searchSelectedIndex = search
		? highlightedIndex(search, filteredDisplaySpaces.length)
		: 0;
	const typeSearch = useCallback(
		(query: string) => {
			const {current} = searchNow;
			if (!searchInputDrawn.current) return;
			if (current && current.query !== query) updateSearch({query, index: 0});
		},
		[updateSearch],
	);

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

	const listLayout = getListLayout(configMemo);
	const linesPerItem = listLayout === 'two_line' ? 2 : 1;

	// The grouped rail interleaves group headers with spaces; search and the
	// flat rail draw the space list as it is.
	const railRows = useMemo(
		() =>
			railGrouped && !isSearching
				? buildRailRows({
						displaySpaces,
						groups: railGroups,
						headers: !stackedLayout,
					})
				: null,
		[railGrouped, isSearching, displaySpaces, railGroups, stackedLayout],
	);
	const cursorRow = railRows
		? resolveCursorRow(railRows, spaces[selectedIndex])
		: -1;
	const allRows =
		railRows ??
		(isSearching ? searchRailRows(activeSpaces) : flatRailRows(activeSpaces));
	const activeSpace = activeSpaces[activeSelectedIndex];
	const allCursor = railRows
		? cursorRow
		: allRows.findIndex(row => isSpaceRow(row) && row.space === activeSpace);

	// Calculate scroll offset for large lists
	const {scrollOffset, visibleCount} = calculateRowWindow(
		allRows.map(row => railRowHeight(row, linesPerItem)),
		allCursor,
		termHeight,
		bannerHeight,
	);
	const visibleRows = allRows.slice(scrollOffset, scrollOffset + visibleCount);
	const visibleCursor = allCursor - scrollOffset;
	// "(a-b of n)" counts spaces, not headers or the divider.
	const spaceRowCount = (rows: readonly RailRow[]) =>
		rows.filter(row => isSpaceRow(row)).length;
	const shownSpaces = spaceRowCount(visibleRows);
	const totalShownSpaces = spaceRowCount(allRows);
	const firstShownSpace = spaceRowCount(allRows.slice(0, scrollOffset)) + 1;
	const railRange =
		shownSpaces < totalShownSpaces
			? ` (${firstShownSpace}-${firstShownSpace + shownSpaces - 1} of ${totalShownSpaces})`
			: '';

	// OpenTUI hit-tests the actual row, including wrapping banners and two-line
	// layouts. Select by identity so filtering and pending rows cannot shift clicks.
	const selectRow = useCallback(
		(name: string) => {
			if (railInputBlocked) return;
			const {current} = searchNow;
			if (current) {
				const index = filteredDisplaySpaces.findIndex(
					space => space.name === name && !space.isPending,
				);
				if (index !== -1) updateSearch({...current, index});
			} else {
				selectSpace(name);
			}
		},
		[railInputBlocked, filteredDisplaySpaces, selectSpace, updateSearch],
	);

	// Space count includes all real spaces (main worktree + issue worktrees), excludes pending rows
	const spaceCount = getSpaceCount(spaces);

	// Render the space list
	const renderList = () => {
		if (activeSpaces.length === 0) {
			return (
				<box
					flexDirection="column"
					paddingY={1}
					paddingLeft={ROW_PADDING_CELLS}
				>
					<text {...dimText()}>
						{isSearching ? 'No matches.' : 'No spaces found.'}
					</text>
					{!isSearching && (
						<text {...dimText()}>Press n to create a new space.</text>
					)}
				</box>
			);
		}

		return (
			<box flexDirection="column">
				{visibleRows.map((row, index) =>
					row.kind === 'divider' ? (
						<RailDivider key="agents-divider" isActive={isRailFocused} />
					) : row.kind === 'header' ? (
						<RailGroupHeader
							key={`group-${row.group.id}`}
							row={row}
							width={termDimensions.cols}
						/>
					) : (
						<SpaceListItem
							key={
								row.kind === 'pending'
									? `pending-${row.space.name}`
									: row.space.name
							}
							space={row.space}
							onSelect={selectRow}
							isSelected={index === visibleCursor}
							width={termDimensions.cols}
							layout={isAgentSpace(row.space) ? 'single_line' : listLayout}
							label={row.space.isMainWorktree ? mainLabel : undefined}
						/>
					),
				)}
			</box>
		);
	};

	// Check if running in tmux
	const inTmux = isInTmux();
	const dialogHeight = termHeight - HEADER_ROWS - bannerHeight;

	if (loading && spaces.length === 0) {
		return (
			<PaneFrame title="rail" isActive={isRailFocused}>
				<box flexDirection="column" padding={1}>
					<text fg={terminalColor()} flexShrink={1}>
						Loading spaces...
					</text>
				</box>
			</PaneFrame>
		);
	}

	const statusFits = statusLineFits(termHeight, bannerHeight, linesPerItem);
	const searchInHeader = !statusFits && isSearching;
	const searchRow = (
		/* Keep the slash and match count at their natural widths;
	   the native input scrolls its text within the remaining space. */
		<box flexDirection="row" width="100%">
			<box flexDirection="row" flexShrink={0}>
				<text
					flexShrink={1}
					fg={terminalColor('cyan')}
					wrapMode="none"
					height={1}
				>
					/
				</text>
			</box>
			<box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={1}>
				<TextInput
					key={searchSession}
					value={searchQuery}
					onChange={typeSearch}
					placeholder="filter by key or title..."
				/>
			</box>
			{filteredDisplaySpaces.length !== displaySpaces.length && (
				<box flexDirection="row" flexShrink={0}>
					<text {...dimText()} wrapMode="none" height={1}>
						{' '}
						({filteredDisplaySpaces.length} match
						{filteredDisplaySpaces.length !== 1 ? 'es' : ''})
					</text>
				</box>
			)}
		</box>
	);

	return (
		<PaneFrame title="rail" isActive={isRailFocused}>
			{/* Keep blank rows in the frame so filtering clears old results.
		    OpenTUI retains and updates only the cells that change. */}
			<box flexDirection="column" height={termHeight}>
				{/* Update banner (only shown if an update is available and not dismissed) */}
				{updateInfo && (
					<UpdateBanner info={updateInfo} onMeasure={setBannerHeight} />
				)}

				{/* One row, so list height calculations stay valid when a pane narrows.
				    A pane too short for the status row searches in this one instead. */}
				<box flexDirection="row" height={1} paddingLeft={ROW_PADDING_CELLS}>
					{searchInHeader ? (
						searchRow
					) : (
						<TruncatedLine
							runs={railHeaderRuns({
								repoName,
								inTmux,
								spaceCount,
								range: railRange,
								errorCount,
							})}
						/>
					)}
				</box>

				{/* Status message line (occupies the row between header and list).
			    Clipped for the same reason as the header above. */}
				{statusFits && (
					<box
						flexDirection="row"
						height={1}
						overflow="hidden"
						paddingLeft={ROW_PADDING_CELLS}
					>
						{isSearching ? (
							searchRow
						) : (
							<TruncatedLine
								runs={[{text: headerMessage, fg: terminalColor('yellow')}]}
							/>
						)}
					</box>
				)}

				{/* Main content */}
				<box flexDirection="column">
					{isZooming ? null : showUpdateConfirm ? (
						<ConfirmDialog
							title={updateConfirmContent.title}
							message={updateConfirmContent.message}
							detail={updateConfirmContent.detail}
							isDestructive={updateConfirmContent.isDestructive}
							onConfirm={handleUpdateConfirmed}
							onCancel={() => setShowUpdateConfirm(false)}
						/>
					) : configMigrations ? (
						<ConfirmDialog
							{...buildConfigMigrationConfirmContent(configMigrations)}
							onConfirm={() => {
								handleConfigMigration(configMigrations);
								setConfigMigrations(null);
							}}
							onCancel={() => setConfigMigrations(null)}
						/>
					) : showPromptDialog ? (
						<PromptDialog
							onSubmit={handleNewSession}
							onCancel={() => setShowPromptDialog(false)}
							savedProfileFor={savedProfileFor}
							availableWidth={termDimensions.cols}
							availableHeight={dialogHeight}
							isInTmux={inTmux}
						/>
					) : killDoneTargets !== null ? (
						<ConfirmDialog
							title={killDoneConfirmContent.title}
							message={killDoneConfirmContent.message}
							detail={killDoneConfirmContent.detail}
							processingMessage={killDoneConfirmContent.processingMessage}
							isDestructive={killDoneConfirmContent.isDestructive}
							onConfirm={async () => handleKillDoneSpaces(killDoneTargets)}
							onCancel={() => setKillDoneTargets(null)}
						/>
					) : deleteTarget ? (
						<CloseSpaceDialog
							spaceName={deleteTarget.name}
							currentIssue={
								deleteTarget.trackerIssue ?? deleteTarget.linearIssue ?? null
							}
							onConfirm={async choice =>
								handleDeleteSpace(deleteTarget, choice)
							}
							onCancel={() => setDeleteTarget(null)}
						/>
					) : showHelp ? (
						<HelpOverlay
							onClose={() => setShowHelp(false)}
							customKeybindings={keybindings}
							commitSha={commitSha}
							installedVersion={installedVersion}
							isDevBuild={isDevBuild}
							availableHeight={dialogHeight}
						/>
					) : showErrorDialog ? (
						<ErrorDialog
							errors={recentErrors}
							onClose={() => setShowErrorDialog(false)}
							onClear={() => {
								clearRecentErrors();
								setShowErrorDialog(false);
							}}
						/>
					) : (
						renderList()
					)}
				</box>
			</box>
		</PaneFrame>
	);
}

function railHeaderRuns(header: {
	repoName: string;
	inTmux: boolean;
	spaceCount: number;
	range: string;
	errorCount: number;
}): Run[] {
	const {fg, attributes} = dimText();
	const dim = {fg, attributes};
	const separator = {text: ' | ', ...dim};
	return [
		{
			text: `🍝 ${header.repoName}`,
			fg: terminalColor('cyan'),
			attributes: textAttributes({bold: true}),
		},
		...(header.inTmux
			? []
			: [separator, {text: 'Not in tmux', fg: terminalColor('yellow')}]),
		separator,
		{
			text: `${header.spaceCount} space${header.spaceCount === 1 ? '' : 's'}${header.range}`,
			...dim,
		},
		...(header.errorCount > 0
			? [
					separator,
					{text: `✗ ${header.errorCount}`, fg: terminalColor('red')},
					{text: ' (e)', ...dim},
				]
			: []),
	];
}

// The new-space dialog picks a profile for every space, so it can't open
// without one. A config that fails to load is left to the dialog to report.
function hasNoProfiles(): boolean {
	try {
		return Object.keys(loadConfig().profiles).length === 0;
	} catch {
		return false;
	}
}

function sendResultMessage(
	result: SendToClaudeResult,
	targetSpace: string,
	text: string,
): string {
	switch (result) {
		case 'sent': {
			return `Agent: ${text}`;
		}

		case 'busy': {
			return `✗ Not sent: another send to ${targetSpace} is still running`;
		}

		case 'wrong-space': {
			return `✗ Not sent: ${targetSpace} is not shown yet`;
		}

		case 'no-session': {
			return `✗ Not sent: ${targetSpace} has no agent session`;
		}

		case 'prompt': {
			return `✗ Not sent: ${targetSpace} is waiting on a prompt; answer it there`;
		}

		case 'draft': {
			return `✗ Not sent: ${targetSpace}'s composer has text that would be cleared`;
		}

		case 'failed': {
			return '✗ Failed to send to the agent';
		}
	}
}
