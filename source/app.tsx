import React, {useEffect, useState, useCallback} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Script is at _dev/scripts/dow/organize-aerospace.sh, TUI runs from _dev/scripts/pappardelle/dist/
const ORGANIZE_SCRIPT = join(
	__dirname,
	'..',
	'..',
	'dow',
	'organize-aerospace.sh',
);
import WorkspaceCard from './components/WorkspaceCard.js';
import NewWorkspaceCard from './components/NewWorkspaceCard.js';
import PromptDialog from './components/PromptDialog.js';
import ConfirmDialog from './components/ConfirmDialog.js';
import ErrorDisplay, {clearRecentErrors} from './components/ErrorDisplay.js';
import {createLogger} from './logger.js';

const log = createLogger('app');
import {
	listWorkspaces,
	listWindowsInWorkspace,
	switchToWorkspace,
	isLinearIssueWorkspace,
	getVisibleWorkspaces,
	getFocusedWorkspace,
	closeWorkspace,
} from './aerospace.js';
import {getIssue, getIssueCached} from './linear.js';
import {
	getClaudeStatus,
	watchStatuses,
	ensureStatusDir,
} from './claude-status.js';
import {isLinearIssueKey, checkIssueHasPRWithCommits} from './issue-checker.js';
import {
	isSSH,
	listClaudeSessions,
	getIssueKeyFromSession,
	switchToTmuxSession,
	killTmuxSession,
} from './tmux.js';
import type {WorkspaceData} from './types.js';

// Check if running over SSH
const IS_SSH_MODE = isSSH();

// Log startup
log.info(`Pappardelle starting (SSH mode: ${IS_SSH_MODE})`);

export default function App() {
	const {stdout} = useStdout();

	const [workspaces, setWorkspaces] = useState<WorkspaceData[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [loading, setLoading] = useState(true);
	const [showPromptDialog, setShowPromptDialog] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [statusMessage, setStatusMessage] = useState('');

	// Calculate grid dimensions based on terminal size
	const termWidth = stdout?.columns ?? 120;
	const termHeight = stdout?.rows ?? 40;

	// Card dimensions
	const cardWidth = 35;
	const cardHeight = 7;
	const gap = 1;

	// Calculate grid layout
	const cols = Math.max(1, Math.floor((termWidth + gap) / (cardWidth + gap)));
	const maxRows = Math.max(
		1,
		Math.floor((termHeight - 4 + gap) / (cardHeight + gap)),
	);

	// Total items = workspaces + 1 (for the + button)
	const totalItems = workspaces.length + 1;

	// Load workspaces (async to not block UI)
	const loadWorkspaces = useCallback(async () => {
		if (IS_SSH_MODE) {
			// SSH mode: load tmux sessions
			const tmuxSessions = listClaudeSessions();

			// Build workspace data from tmux sessions
			const workspaceData: WorkspaceData[] = tmuxSessions.map(session => {
				const issueKey = getIssueKeyFromSession(session.name);
				const claudeStatus = issueKey ? getClaudeStatus(issueKey) : undefined;

				// Start fetching Linear issue in background
				if (issueKey) {
					getIssue(issueKey).catch(() => {});
				}

				return {
					name: issueKey ?? session.name,
					isLinearIssue: Boolean(issueKey),
					linearIssue: issueKey
						? getIssueCached(issueKey) ?? undefined
						: undefined,
					windows: [], // No window info in SSH mode
					claudeStatus,
					isVisible: session.attached,
					tmuxSession: session.name, // Store tmux session name for switching
				};
			});

			setWorkspaces(workspaceData);
			setLoading(false);
			return;
		}

		// GUI mode: load aerospace workspaces
		const [workspaceNames, visibleWorkspaces] = await Promise.all([
			listWorkspaces(),
			getVisibleWorkspaces(),
		]);

		// Filter to only Linear issue workspaces
		const linearWorkspaces = workspaceNames.filter(isLinearIssueWorkspace);

		// Fetch all window lists in parallel
		const windowsPromises = linearWorkspaces.map(name =>
			listWindowsInWorkspace(name),
		);
		const windowsResults = await Promise.all(windowsPromises);

		// Build workspace data
		const workspaceData: WorkspaceData[] = linearWorkspaces.map((name, i) => {
			const claudeStatus = getClaudeStatus(name);

			// Start fetching Linear issue in background
			getIssue(name).catch(() => {});

			return {
				name,
				isLinearIssue: true,
				linearIssue: getIssueCached(name) ?? undefined,
				windows: windowsResults[i] ?? [],
				claudeStatus,
				isVisible: visibleWorkspaces.includes(name),
			};
		});

		setWorkspaces(workspaceData);
		setLoading(false);
	}, []);

	// Initial load
	useEffect(() => {
		ensureStatusDir();
		loadWorkspaces();

		// Refresh every 500ms (async so doesn't block UI)
		const interval = setInterval(() => {
			loadWorkspaces();
		}, 500);

		return () => clearInterval(interval);
	}, [loadWorkspaces]);

	// Watch for Claude status changes
	useEffect(() => {
		const unwatch = watchStatuses((workspaceName, status) => {
			setWorkspaces(prev =>
				prev.map(w =>
					w.name === workspaceName ? {...w, claudeStatus: status} : w,
				),
			);
		});

		return unwatch;
	}, []);

	// Handle keyboard input
	useInput(
		(input, key) => {
			if (showPromptDialog || showDeleteConfirm) {
				return; // Dialogs handle their own input
			}

			const rows = Math.ceil(totalItems / cols);
			const currentRow = Math.floor(selectedIndex / cols);
			const currentCol = selectedIndex % cols;

			if (key.upArrow) {
				if (currentRow > 0) {
					const newIndex = (currentRow - 1) * cols + currentCol;
					setSelectedIndex(Math.min(newIndex, totalItems - 1));
				}
			} else if (key.downArrow) {
				if (currentRow < rows - 1) {
					const newIndex = (currentRow + 1) * cols + currentCol;
					setSelectedIndex(Math.min(newIndex, totalItems - 1));
				}
			} else if (key.leftArrow) {
				if (selectedIndex > 0) {
					setSelectedIndex(selectedIndex - 1);
				}
			} else if (key.rightArrow) {
				if (selectedIndex < totalItems - 1) {
					setSelectedIndex(selectedIndex + 1);
				}
			} else if (key.return) {
				// Enter pressed
				if (selectedIndex === workspaces.length) {
					// + button selected
					setShowPromptDialog(true);
				} else {
					// Workspace selected - switch to it
					const workspace = workspaces[selectedIndex];
					if (workspace) {
						if (IS_SSH_MODE && workspace.tmuxSession) {
							// SSH mode: switch tmux session
							const success = switchToTmuxSession(workspace.tmuxSession);
							if (success) {
								setStatusMessage(`Switched to ${workspace.name}`);
								setTimeout(() => setStatusMessage(''), 2000);
							} else {
								setStatusMessage(
									`Run: tmux attach -t ${workspace.tmuxSession}`,
								);
								setTimeout(() => setStatusMessage(''), 5000);
							}
						} else {
							// GUI mode: switch aerospace workspace
							const originalWorkspace = getFocusedWorkspace();
							const success = switchToWorkspace(workspace.name);
							if (success) {
								setStatusMessage(`Switched to ${workspace.name}`);
								// Return focus to original workspace after delay for window positioning
								setTimeout(() => {
									if (originalWorkspace) {
										switchToWorkspace(originalWorkspace);
									}
									setStatusMessage('');
								}, 500);
							}
						}
					}
				}
			} else if (input === 'n') {
				// 'n' for new session
				setShowPromptDialog(true);
			} else if (key.delete) {
				// Delete key to delete selected workspace
				if (selectedIndex < workspaces.length) {
					setShowDeleteConfirm(true);
				}
			} else if (input === 'l') {
				// Layout windows for selected workspace
				if (selectedIndex < workspaces.length) {
					const workspace = workspaces[selectedIndex];
					if (workspace) {
						setStatusMessage(`Laying out ${workspace.name}...`);
						const child = spawn(
							ORGANIZE_SCRIPT,
							['--issue-key', workspace.name],
							{
								detached: true,
								stdio: 'ignore',
								env: process.env,
							},
						);
						child.unref();
						setTimeout(() => {
							setStatusMessage(`Layout complete for ${workspace.name}`);
							setTimeout(() => setStatusMessage(''), 2000);
						}, 1000);
					}
				}
			} else if (input === 'c') {
				// Clear errors
				clearRecentErrors();
			}
		},
		{isActive: !showPromptDialog && !showDeleteConfirm},
	);

	// Helper to spawn dow and capture errors
	const spawnDow = (
		args: string[],
		statusMessageOnStart: string,
		statusMessageOnSuccess: string,
	) => {
		setStatusMessage(statusMessageOnStart);

		const child = spawn('dow', args, {
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
			log.error(`Failed to spawn dow: ${err.message}`, err);
			setStatusMessage(`Failed to start: ${err.message}`);
			setTimeout(() => setStatusMessage(''), 5000);
		});

		child.on('close', code => {
			if (code !== 0 && code !== null) {
				// Extract meaningful error message from output
				const errorMsg =
					stderrData.trim() ||
					stdoutData.match(/Error: .*/)?.[0] ||
					`dow exited with code ${code}`;
				log.error(`dow failed (exit ${code}): ${errorMsg}`);
				setStatusMessage(`Failed: ${errorMsg.slice(0, 60)}`);
				setTimeout(() => setStatusMessage(''), 5000);
			} else {
				setStatusMessage(statusMessageOnSuccess);
				setTimeout(() => {
					setStatusMessage('');
					loadWorkspaces();
				}, 3000);
			}
		});

		child.unref();
		log.info(`Started dow with args: ${args.join(' ')}`);
	};

	// Handle new session creation
	const handleNewSession = (input: string) => {
		setShowPromptDialog(false);

		// Check if input is a Linear issue key (e.g., STA-123)
		const trimmedInput = input.trim().toUpperCase();

		if (isLinearIssueKey(trimmedInput)) {
			setStatusMessage(`Checking ${trimmedInput} for existing PR...`);

			// Check if issue has a PR with commits
			const prInfo = checkIssueHasPRWithCommits(trimmedInput);

			if (prInfo.hasPR && prInfo.hasCommits) {
				// Issue has PR with commits - open workspace without prompting Claude
				spawnDow(
					['--resume', trimmedInput],
					`Resuming ${trimmedInput} (PR #${prInfo.prNumber} has commits)...`,
					`Opened ${trimmedInput} in resume mode`,
				);
				return;
			}
		}

		// Not an issue with existing PR, or no commits - start new session with prompt
		spawnDow(
			[input],
			'Starting new DOW session...',
			'DOW session started! Check your new workspace.',
		);
	};

	// Handle workspace deletion
	const handleDeleteWorkspace = () => {
		setShowDeleteConfirm(false);

		const workspace = workspaces[selectedIndex];
		if (!workspace) return;

		setStatusMessage(`Closing ${workspace.name}...`);

		if (IS_SSH_MODE && workspace.tmuxSession) {
			// SSH mode: kill tmux session
			const success = killTmuxSession(workspace.tmuxSession);
			if (success) {
				setStatusMessage(`Closed tmux session ${workspace.name}`);
				// Adjust selection if needed
				if (selectedIndex >= workspaces.length - 1 && selectedIndex > 0) {
					setSelectedIndex(selectedIndex - 1);
				}
			} else {
				setStatusMessage(`Failed to close ${workspace.name}`);
			}
		} else {
			// GUI mode: close workspace windows
			closeWorkspace(workspace.name)
				.then(success => {
					if (success) {
						setStatusMessage(`Closed workspace ${workspace.name}`);
						// Adjust selection if needed
						if (selectedIndex >= workspaces.length - 1 && selectedIndex > 0) {
							setSelectedIndex(selectedIndex - 1);
						}
					} else {
						setStatusMessage(`Failed to close ${workspace.name}`);
					}
				})
				.catch(err => {
					log.error(`Failed to close workspace: ${err}`);
					setStatusMessage(`Error closing ${workspace.name}`);
				});
		}

		setTimeout(() => setStatusMessage(''), 3000);
		loadWorkspaces();
	};

	// Get workspace to delete (for confirmation dialog)
	const workspaceToDelete = workspaces[selectedIndex];

	// Render grid of workspace cards
	const renderGrid = () => {
		const rows: React.ReactNode[] = [];
		let itemIndex = 0;

		for (let row = 0; row < maxRows && itemIndex < totalItems; row++) {
			const rowItems: React.ReactNode[] = [];

			for (let col = 0; col < cols && itemIndex < totalItems; col++) {
				if (itemIndex < workspaces.length) {
					const workspace = workspaces[itemIndex]!;
					rowItems.push(
						<WorkspaceCard
							key={workspace.name}
							workspace={workspace}
							isSelected={itemIndex === selectedIndex}
							width={cardWidth}
							height={cardHeight}
						/>,
					);
				} else {
					// + button
					rowItems.push(
						<NewWorkspaceCard
							key="new-session"
							isSelected={itemIndex === selectedIndex}
							width={cardWidth}
							height={cardHeight}
						/>,
					);
				}

				itemIndex++;
			}

			rows.push(
				<Box key={row} gap={gap}>
					{rowItems}
				</Box>,
			);
		}

		return rows;
	};

	if (loading && workspaces.length === 0) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text>Loading workspaces...</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			{/* Header */}
			<Box marginBottom={1}>
				<Text bold color="cyan">
					DOW Workspaces
				</Text>
				{IS_SSH_MODE && (
					<>
						<Text dimColor> | </Text>
						<Text color="yellow">SSH</Text>
					</>
				)}
				<Text dimColor> | </Text>
				<Text dimColor>
					↑↓←→ navigate, Enter select, n new, Del close
					{!IS_SSH_MODE && ', l layout'}
				</Text>
			</Box>

			{/* Status message */}
			{statusMessage && (
				<Box marginBottom={1}>
					<Text color="yellow">{statusMessage}</Text>
				</Box>
			)}

			{/* Grid or Dialog */}
			{showPromptDialog ? (
				<Box justifyContent="center" alignItems="center">
					<PromptDialog
						onSubmit={handleNewSession}
						onCancel={() => setShowPromptDialog(false)}
					/>
				</Box>
			) : showDeleteConfirm && workspaceToDelete ? (
				<Box justifyContent="center" alignItems="center">
					<ConfirmDialog
						title="Close Workspace"
						message={`Close workspace ${workspaceToDelete.name}?`}
						detail="This will close all windows in this workspace. The worktree and git branch will remain."
						onConfirm={handleDeleteWorkspace}
						onCancel={() => setShowDeleteConfirm(false)}
					/>
				</Box>
			) : (
				<Box flexDirection="column" gap={gap}>
					{renderGrid()}
				</Box>
			)}

			{/* Footer */}
			<Box marginTop={1}>
				<Text dimColor>
					{workspaces.length} {IS_SSH_MODE ? 'tmux session' : 'workspace'}
					{workspaces.length !== 1 ? 's' : ''} | {termWidth}x{termHeight}
				</Text>
			</Box>

			{/* Error display */}
			<ErrorDisplay maxVisible={3} />
		</Box>
	);
}
