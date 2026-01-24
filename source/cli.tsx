#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import {execSync, spawnSync} from 'node:child_process';
import App from './app.js';
import {isInTmux, setupPappardellLayout} from './tmux.js';
import type {PaneLayout} from './types.js';

const cli = meow(
	`
	Usage
	  $ pappardelle

	Description
	  Interactive TUI for managing DOW (Day of Work) workspaces.
	  Displays worktree spaces in an fzf-style list with Claude and
	  lazygit panes for the selected space.

	Controls
	  j/k or arrows  Navigate between spaces
	  Enter          Select space
	  n              New space (create worktree + issue)
	  d              Delete selected space
	  r              Refresh list
	  q/Ctrl+C       Quit

	Options
	  --no-layout    Don't set up tmux pane layout (run standalone)

	Examples
	  $ pappardelle              # Run with tmux layout
	  $ pappardelle --no-layout  # Run standalone (list only)
`,
	{
		importMeta: import.meta,
		flags: {
			noLayout: {
				type: 'boolean',
				default: false,
			},
		},
	},
);

// Check if running in a git repository
function isGitRepository(): boolean {
	try {
		execSync('git rev-parse --git-dir', {stdio: 'pipe'});
		return true;
	} catch {
		return false;
	}
}

if (!isGitRepository()) {
	console.error(
		'\x1b[31mError: pappardelle must be run from within a git repository.\x1b[0m',
	);
	console.error(
		'\x1b[33mPlease navigate to a git repository and try again.\x1b[0m',
	);
	process.exit(1);
}

// If not in tmux, re-exec inside tmux
if (!isInTmux() && !cli.flags.noLayout) {
	const args = process.argv.slice(2).join(' ');
	const cmd = args ? `pappardelle ${args}` : 'pappardelle';

	// Generate unique session name so each run is a fresh process
	const sessionName = `pappardelle-${Date.now()}`;

	// Start new tmux session (no -A flag, always create fresh)
	const result = spawnSync('tmux', ['new-session', '-s', sessionName, cmd], {
		stdio: 'inherit',
		env: process.env,
	});
	process.exit(result.status ?? 0);
}

// Set up tmux layout if in tmux and not disabled
let paneLayout: PaneLayout | null = null;

if (isInTmux() && !cli.flags.noLayout) {
	paneLayout = setupPappardellLayout();
	if (!paneLayout) {
		console.error(
			'\x1b[33mWarning: Failed to set up tmux pane layout. Running in standalone mode.\x1b[0m',
		);
	}
}

// Helper to clear the screen completely
const clearScreen = () => {
	process.stdout.write('\x1b[2J'); // Clear screen
	process.stdout.write('\x1b[H'); // Move cursor to home
	process.stdout.write('\x1b[3J'); // Clear scrollback buffer
};

// Enter alternate screen buffer for full-screen mode
process.stdout.write('\x1b[?1049h'); // Enter alt screen
clearScreen();

// Cleanup on exit
const cleanup = () => {
	process.stdout.write('\x1b[?1049l'); // Exit alt screen
};

process.on('exit', cleanup);
process.on('SIGINT', () => {
	cleanup();
	process.exit(0);
});
process.on('SIGTERM', () => {
	cleanup();
	process.exit(0);
});

// Render the app
render(<App paneLayout={paneLayout} />);

// Handle terminal resize - Ink handles repainting, but clear artifacts first
process.stdout.on('resize', () => {
	clearScreen();
});
