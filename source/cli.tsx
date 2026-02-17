#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import App from './app.tsx';
import {isInTmux, sessionExists, setupPappardellLayout} from './tmux.ts';
import type {PaneLayout} from './types.ts';
import {
	configExists,
	getRepoRoot,
	getRepoName,
	loadConfig,
	loadProviderConfigs,
	getTeamPrefix,
	ConfigNotFoundError,
	ConfigValidationError,
} from './config.ts';
import {captureStderr} from './logger.ts';

// Capture stderr early so Ink/React rendering errors go to the log file
captureStderr();
import {createIssueTracker, createVcsHost} from './providers/index.ts';
import {normalizeIssueIdentifier} from './issue-checker.ts';
import {buildSpawnEnv} from './spawn-env.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

const cli = meow(
	`
	Usage
	  $ pappardelle [prompt]

	Description
	  Interactive TUI for managing pappardelle workspaces.
	  Displays worktree spaces in an fzf-style list with Claude and
	  lazygit panes for the selected space.

	  If a prompt is provided, creates a new session directly without
	  entering the interactive TUI.

	Controls
	  j/k or arrows  Navigate between spaces
	  Enter          Select space
	  n              New space (create worktree + issue)
	  o              Open workspace (apps, links, iTerm, etc.)
	  d              Delete selected space
	  r              Refresh list
	  q/Ctrl+C       Quit

	Options
	  --no-layout    Don't set up tmux pane layout (run standalone)
	  --no-iterm     Disable iTerm2 native pane integration (use regular tmux)

	Examples
	  $ pappardelle              # Run with tmux layout
	  $ pappardelle --no-layout  # Run standalone (list only)
	  $ pappardelle --no-iterm   # Force regular tmux (no native panes)
	  $ pappardelle "fix auth bug"  # Create new session with prompt
`,
	{
		importMeta: import.meta,
		flags: {
			layout: {
				type: 'boolean',
				default: true,
			},
			iterm: {
				type: 'boolean',
				default: true,
			},
		},
	},
);

// Check for .pappardelle.yml config file
function checkConfig(): void {
	try {
		const repoRoot = getRepoRoot();
		if (!configExists()) {
			console.error(
				'\x1b[31mError: No .pappardelle.yml found at repository root.\x1b[0m',
			);
			console.error('');
			console.error(
				'\x1b[33mPappardelle requires a configuration file to operate.\x1b[0m',
			);
			console.error(
				`Please create .pappardelle.yml at: ${repoRoot}/.pappardelle.yml`,
			);
			console.error('');
			console.error(
				'See https://github.com/chardigio/pappardelle for the configuration schema.',
			);
			process.exit(1);
		}
	} catch (error) {
		if (error instanceof ConfigNotFoundError) {
			console.error(
				'\x1b[31mError: No .pappardelle.yml found at repository root.\x1b[0m',
			);
			console.error('');
			console.error(
				`Please create .pappardelle.yml at: ${error.repoRoot}/.pappardelle.yml`,
			);
			process.exit(1);
		} else if (error instanceof ConfigValidationError) {
			console.error(
				'\x1b[31mError: Invalid .pappardelle.yml configuration.\x1b[0m',
			);
			console.error('');
			for (const err of error.errors) {
				console.error(`  - ${err}`);
			}
			console.error('');
			console.error('Please fix the configuration and try again.');
			process.exit(1);
		} else {
			// Not in a git repository
			console.error(
				'\x1b[31mError: pappardelle must be run from within a git repository.\x1b[0m',
			);
			console.error(
				'\x1b[33mPlease navigate to a git repository and try again.\x1b[0m',
			);
			process.exit(1);
		}
	}
}

checkConfig();

// Initialize provider singletons from config so that all subsequent
// no-arg calls (e.g. from linear.ts facade) use the correct provider.
// Uses loadProviderConfigs() instead of loadConfig() so that provider
// initialization succeeds even when unrelated config sections (e.g.
// profiles) have validation errors.
try {
	const providerCfg = loadProviderConfigs();
	createIssueTracker(providerCfg.issue_tracker);
	createVcsHost(providerCfg.vcs_host);
} catch {
	// If loading fails the providers will fall back to defaults on first use.
}

// If a prompt is provided as positional argument, spawn idow directly and exit
if (cli.input.length > 0) {
	const prompt = cli.input.join(' ');

	// Normalize issue identifiers (supports bare numbers like '400')
	let config;
	try {
		config = loadConfig();
	} catch {
		config = null;
	}

	const teamPrefix = config ? getTeamPrefix(config) : 'STA';
	const normalizedIssueKey = normalizeIssueIdentifier(prompt, teamPrefix);
	const finalPrompt = normalizedIssueKey ?? prompt;

	console.log(`Starting new session with: "${finalPrompt}"`);

	const result = spawnSync(path.join(SCRIPTS_DIR, 'idow'), [finalPrompt], {
		stdio: 'inherit',
		cwd: getRepoRoot(),
		env: buildSpawnEnv(getRepoRoot()),
	});

	process.exit(result.status ?? 0);
}

// Detect iTerm2 for native pane support via tmux -CC (control mode).
// When attached via -CC, iTerm2 renders tmux panes as native split panes,
// giving you mouse-drag resizing, Cmd+[/] pane switching, native scrollback,
// Cmd+F search, and macOS copy/paste.
const useItermNativePanes =
	cli.flags.iterm && process.env['TERM_PROGRAM'] === 'iTerm.app';

// If not in tmux, re-exec inside tmux
if (!isInTmux() && cli.flags.layout) {
	const repoName = getRepoName();
	const sessionName = `pappardelle-${repoName}`;

	// Check if a pappardelle session already exists
	if (sessionExists(sessionName)) {
		// Attach to the existing session
		const tmuxArgs = [
			...(useItermNativePanes ? ['-CC'] : []),
			'attach-session',
			'-t',
			sessionName,
		];
		const result = spawnSync('tmux', tmuxArgs, {
			stdio: 'inherit',
			env: process.env,
		});
		process.exit(result.status ?? 0);
	}

	// No existing session - create a new one
	const args = process.argv.slice(2).join(' ');
	const cmd = args ? `pappardelle ${args}` : 'pappardelle';

	const tmuxArgs = [
		...(useItermNativePanes ? ['-CC'] : []),
		'new-session',
		'-s',
		sessionName,
		cmd,
	];
	const result = spawnSync('tmux', tmuxArgs, {
		stdio: 'inherit',
		env: process.env,
	});
	process.exit(result.status ?? 0);
}

// Set up tmux layout if in tmux and not disabled
let paneLayout: PaneLayout | null = null;

if (isInTmux() && cli.flags.layout) {
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
	// Disable mouse tracking before exiting
	process.stdout.write('\x1b[?1006l');
	process.stdout.write('\x1b[?1000l');
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

// NOTE: Screen clearing on resize is handled inside app.tsx's resize handler,
// NOT here. Clearing here (in a separate listener) can race with Ink's render
// cycle — if clearScreen fires *after* Ink's re-render, the screen stays blank
// until the next state change. Keeping clear + setTermDimensions in the same
// handler guarantees a React re-render always follows the clear.
