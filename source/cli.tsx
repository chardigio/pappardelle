#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
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
