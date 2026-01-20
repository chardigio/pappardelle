#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import {execSync} from 'node:child_process';
import App from './app.js';

meow(
	`
	Usage
	  $ pappardelle

	Description
	  Interactive TUI for managing DOW (Day of Work) workspaces.
	  Displays aerospace workspaces as cards showing Linear issue info,
	  open applications, and Claude Code status.

	Controls
	  Arrow keys  Navigate between workspaces
	  Enter       Switch to selected workspace (or open new session dialog)
	  Ctrl+C      Quit

	Examples
	  $ pappardelle
`,
	{
		importMeta: import.meta,
		flags: {},
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
	console.error('\x1b[31mError: pappardelle must be run from within a git repository.\x1b[0m');
	console.error('\x1b[33mPlease navigate to a git repository and try again.\x1b[0m');
	process.exit(1);
}

// Enter alternate screen buffer for full-screen mode
process.stdout.write('\x1b[?1049h'); // Enter alt screen
process.stdout.write('\x1b[2J'); // Clear screen
process.stdout.write('\x1b[H'); // Move cursor to home

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

render(<App />);
