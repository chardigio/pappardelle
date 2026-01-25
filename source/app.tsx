import React, {useEffect, useState, useCallback, useRef} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import {spawn} from 'node:child_process';

import SpaceListItem from './components/SpaceListItem.js';
import PromptDialog from './components/PromptDialog.js';
import ConfirmDialog from './components/ConfirmDialog.js';
import ErrorDisplay, {clearRecentErrors} from './components/ErrorDisplay.js';
import {createLogger} from './logger.js';

const log = createLogger('app');

import {getIssue, getIssueCached} from './linear.js';
import {
	getClaudeStatus,
	watchStatuses,
	ensureStatusDir,
} from './claude-status.js';
import {isLinearIssueKey, checkIssueHasPRWithCommits} from './issue-checker.js';
import {
	isInTmux,
	getWorktreePath,
	attachToSpace,
	displayMessageInPane,
	killSpaceSessions,
	getLinearIssuesFromTmux,
	zoomPane,
	unzoomPane,
	resizeListPaneForSessionCount,
	isVerticalLayout,
} from './tmux.js';
import type {SpaceData, PaneLayout} from './types.js';

// Props passed from cli.tsx with pane layout info
interface AppProps {
	paneLayout: PaneLayout | null;
}

log.info('Pappardelle starting');

export default function App({paneLayout}: AppProps) {
	const {stdout} = useStdout();

	const [spaces, setSpaces] = useState<SpaceData[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [loading, setLoading] = useState(true);
	const [showPromptDialog, setShowPromptDialog] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [statusMessage, setStatusMessage] = useState('');
	const [currentSpace, setCurrentSpace] = useState<string | null>(null);

	// Track if panes have been initialized
	const panesInitialized = useRef(false);

	// Track terminal dimensions with resize handling
	const [termDimensions, setTermDimensions] = useState({
		rows: stdout?.rows ?? 40,
		cols: stdout?.columns ?? 80,
	});

	// Listen for terminal resize events to update dimensions
	// (cli.tsx handles screen clearing on resize)
	useEffect(() => {
		if (!stdout) return;

		const handleResize = () => {
			setTermDimensions({
				rows: stdout.rows ?? 40,
				cols: stdout.columns ?? 80,
			});
		};

		stdout.on('resize', handleResize);
		return () => {
			stdout.off('resize', handleResize);
		};
	}, [stdout]);

	// Calculate dimensions
	const termHeight = termDimensions.rows;
	const maxVisibleItems = Math.max(1, termHeight - 6); // Header + footer + padding

	// Load spaces from active tmux sessions (claude-* sessions)
	const loadSpaces = useCallback(async () => {
		try {
			// Get Linear issue keys from active claude tmux sessions
			const workspaceNames = getLinearIssuesFromTmux();

			// Build space data
			const spaceData: SpaceData[] = workspaceNames.map(issueKey => {
				const claudeStatus = getClaudeStatus(issueKey);
				const worktreePath = getWorktreePath(issueKey);

				// Start fetching Linear issue in background
				getIssue(issueKey).catch(() => {});

				return {
					name: issueKey,
					linearIssue: getIssueCached(issueKey) ?? undefined,
					claudeStatus,
					worktreePath,
				};
			});

			// Sort by issue number (most recent first)
			spaceData.sort((a, b) => {
				const aNum = parseInt(a.name.split('-')[1] ?? '0', 10);
				const bNum = parseInt(b.name.split('-')[1] ?? '0', 10);
				return bNum - aNum;
			});

			setSpaces(spaceData);
			setLoading(false);
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

		// Refresh every 2 seconds
		const interval = setInterval(() => {
			loadSpaces();
		}, 2000);

		return () => clearInterval(interval);
	}, [loadSpaces]);

	// Watch for Claude status changes
	useEffect(() => {
		const unwatch = watchStatuses((workspaceName, status) => {
			setSpaces(prev =>
				prev.map(s =>
					s.name === workspaceName ? {...s, claudeStatus: status} : s,
				),
			);
		});

		return unwatch;
	}, []);

	// Track whether zoom animation is in progress
	// Dialog rendering is delayed until after zoom completes to work around Ink rendering bug
	const [isZooming, setIsZooming] = useState(false);

	// Zoom/unzoom list pane when prompt dialog is shown/hidden
	// This gives full screen space for entering the prompt text
	useEffect(() => {
		if (!paneLayout) return;

		if (showPromptDialog) {
			setIsZooming(true);
			zoomPane(paneLayout.listPaneId);
			// Wait for zoom to complete before allowing render
			setTimeout(() => setIsZooming(false), 100);
		} else {
			setIsZooming(true);
			unzoomPane(paneLayout.listPaneId);
			setTimeout(() => setIsZooming(false), 100);
		}
	}, [showPromptDialog, paneLayout]);

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

	// Handle keyboard input
	useInput(
		(input, key) => {
			if (showPromptDialog || showDeleteConfirm) {
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
				// Enter pressed - for now, just confirm selection
				const space = spaces[selectedIndex];
				if (space) {
					setStatusMessage(`Selected ${space.name}`);
					setTimeout(() => setStatusMessage(''), 2000);
				}
			} else if (input === 'n') {
				// 'n' for new session
				setShowPromptDialog(true);
			} else if (key.delete || input === 'd') {
				// Delete key or 'd' to delete selected space
				if (selectedIndex < spaces.length) {
					setShowDeleteConfirm(true);
				}
			} else if (input === 'c') {
				// Clear errors
				clearRecentErrors();
			} else if (input === 'r') {
				// Refresh
				loadSpaces();
				setStatusMessage('Refreshed');
				setTimeout(() => setStatusMessage(''), 1000);
			}
		},
		{isActive: !showPromptDialog && !showDeleteConfirm},
	);

	// Helper to spawn idow and capture errors
	const spawnIdow = (
		args: string[],
		statusMessageOnStart: string,
		statusMessageOnSuccess: string,
	) => {
		setStatusMessage(statusMessageOnStart);

		const child = spawn('idow', args, {
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
		});

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
			setStatusMessage(`Failed to start: ${err.message}`);
			setTimeout(() => setStatusMessage(''), 5000);
		});

		child.on('close', code => {
			if (code !== 0 && code !== null) {
				const errorMsg =
					stderrData.trim() ||
					stdoutData.match(/Error: .*/)?.[0] ||
					`idow exited with code ${code}`;
				log.error(`idow failed (exit ${code}): ${errorMsg}`);
				setStatusMessage(`Failed: ${errorMsg.slice(0, 60)}`);
				setTimeout(() => setStatusMessage(''), 5000);
			} else {
				setStatusMessage(statusMessageOnSuccess);
				setTimeout(() => {
					setStatusMessage('');
					loadSpaces();
				}, 3000);
			}
		});

		child.unref();
		log.info(`Started idow with args: ${args.join(' ')}`);
	};

	// Handle new session creation
	const handleNewSession = (input: string) => {
		setShowPromptDialog(false);

		const trimmedInput = input.trim().toUpperCase();

		if (isLinearIssueKey(trimmedInput)) {
			setStatusMessage(`Checking ${trimmedInput} for existing PR...`);

			const prInfo = checkIssueHasPRWithCommits(trimmedInput);

			if (prInfo.hasPR && prInfo.hasCommits) {
				spawnIdow(
					['--resume', trimmedInput],
					`Resuming ${trimmedInput} (PR #${prInfo.prNumber} has commits)...`,
					`Opened ${trimmedInput} in resume mode`,
				);
				return;
			}

			spawnIdow(
				[trimmedInput],
				`Starting ${trimmedInput}...`,
				`Opened ${trimmedInput}`,
			);
			return;
		}

		// For descriptions, idow will create a new issue
		spawnIdow([input], 'Starting new IDOW session...', 'IDOW session started!');
	};

	// Handle space deletion (kills tmux sessions for the space)
	const handleDeleteSpace = () => {
		setShowDeleteConfirm(false);

		const space = spaces[selectedIndex];
		if (!space) return;

		// Kill the claude and lazygit tmux sessions for this space
		const sessionsKilled = killSpaceSessions(space.name);

		if (sessionsKilled) {
			setStatusMessage(`Closed sessions for ${space.name}`);
		} else {
			setStatusMessage(`Partially closed sessions for ${space.name}`);
		}

		// Clear the viewer panes since we killed the sessions
		if (paneLayout && currentSpace === space.name) {
			displayMessageInPane(paneLayout.claudeViewerPaneId, 'Session closed');
			displayMessageInPane(paneLayout.lazygitViewerPaneId, 'Session closed');
			setCurrentSpace(null);
		}

		// Adjust selection if needed
		if (selectedIndex >= spaces.length - 1 && selectedIndex > 0) {
			setSelectedIndex(selectedIndex - 1);
		}

		setTimeout(() => setStatusMessage(''), 3000);
		loadSpaces();
	};

	// Get space to delete (for confirmation dialog)
	const spaceToDelete = spaces[selectedIndex];

	// Calculate scroll offset for large lists
	const scrollOffset = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(maxVisibleItems / 2),
			spaces.length - maxVisibleItems,
		),
	);
	const visibleSpaces = spaces.slice(
		scrollOffset,
		scrollOffset + maxVisibleItems,
	);
	const adjustedSelectedIndex = selectedIndex - scrollOffset;

	// Render the space list
	const renderList = () => {
		if (spaces.length === 0) {
			return (
				<Box flexDirection="column" paddingY={1}>
					<Text dimColor>No spaces found.</Text>
					<Text dimColor>Press n to create a new space.</Text>
				</Box>
			);
		}

		return (
			<Box flexDirection="column">
				{visibleSpaces.map((space, index) => (
					<SpaceListItem
						key={space.name}
						space={space}
						isSelected={index === adjustedSelectedIndex}
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
			<Box marginBottom={1}>
				<Text bold color="cyan">
					pappardelle
				</Text>
				{!inTmux && (
					<>
						<Text dimColor> | </Text>
						<Text color="yellow">Not in tmux</Text>
					</>
				)}
				<Text dimColor> | </Text>
				<Text dimColor>j/k navigate, n new, d delete, r refresh, q quit</Text>
			</Box>

			{/* Status message */}
			{statusMessage && (
				<Box marginBottom={1}>
					<Text color="yellow">{statusMessage}</Text>
				</Box>
			)}

			{/* Main content */}
			<Box flexDirection="column">
				{showPromptDialog && !isZooming ? (
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
				) : (
					renderList()
				)}
			</Box>

			{/* Footer */}
			<Box marginTop={1}>
				<Text dimColor>
					{spaces.length} space{spaces.length !== 1 ? 's' : ''}
					{scrollOffset > 0 &&
						` (${scrollOffset + 1}-${scrollOffset + visibleSpaces.length})`}
				</Text>
			</Box>

			{/* Error display */}
			<ErrorDisplay maxVisible={2} />
		</Box>
	);
}
