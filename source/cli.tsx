#!/usr/bin/env node
import React from 'react';
import {renderTui} from './render-tui.ts';
import {execSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import App from './app.tsx';
import {
	cleanupOrphanedInnerSessions,
	cleanupOrphanedOuterSessions,
	migrateLegacyAgentSessions,
	isInTmux,
	outerSessionName,
	sendToSpaceAgent,
	sessionExists,
	setupPappardellLayout,
	getSessionNames,
	INNER_SOCKET,
} from './tmux.ts';
import type {PaneLayout} from './types.ts';
import {
	configExists,
	getRepoRoot,
	getMainRepoRoot,
	getRepoName,
	loadConfig,
	loadProviderConfigs,
	getBeadsPrefixes,
	readBeadsIssuePrefix,
	getTeamPrefix,
	ConfigNotFoundError,
	ConfigValidationError,
} from './config.ts';
import {captureStderr, setStderrTerminalPassthrough} from './logger.ts';

// Capture stderr early so Ink/React rendering errors go to the log file
captureStderr();
import {loadEnvrcIntoProcessEnv} from './envrc.ts';
import {createIssueTracker, createVcsHost} from './providers/index.ts';
import {normalizeIssueIdentifier} from './issue-checker.ts';
import {resolveSpaceKey} from './issue-utils.ts';
import {buildSpawnEnv} from './spawn-env.ts';
import {getRegisteredSpaces, initForRepo} from './space-registry.ts';
import {initStateColorCacheDir} from './providers/state-color-cache.ts';
import {writeHighlightTarget} from './highlight.ts';
import {resolveDisplayVersion, safeCheckForUpdate} from './update-check.ts';
import {createNormalizingStdin} from './components/kitty-keyboard.ts';
import {linkPr} from './link-pr.ts';
import {parseCli} from './cli-args.ts';
import {tuiLaunchCommand} from './tui-sessions.ts';
import {defaultUpdateCommandDeps, runUpdateCommand} from './update-command.ts';
import {
	defaultRestartCommandDeps,
	hardRestart,
	restartRepo,
} from './restart-command.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

const cli = parseCli();

const pappardelleDir = path.resolve(__dirname, '..');

const isRestart = cli.input.length === 1 && cli.input[0] === 'restart';

// Dispatched before checkConfig so these work from any directory, not just a
// repo with a .pappardelle.yml.
if (cli.input.length === 1 && cli.input[0] === 'update') {
	process.exit(
		await runUpdateCommand(
			{restartTuis: cli.flags.restartTuis},
			defaultUpdateCommandDeps(pappardelleDir),
		),
	);
}

if (isRestart && cli.flags.hard) {
	process.exit(
		await hardRestart(cli.flags.yes ?? false, defaultRestartCommandDeps()),
	);
}

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

if (cli.input[0] === 'link-pr') {
	try {
		if (cli.input.length !== 2)
			throw new Error(
				'Usage: pappardelle link-pr <url> [--workspace <workspace-root>]',
			);
		const result = await linkPr(
			cli.input[1]!,
			process.cwd(),
			cli.flags.workspace ? path.resolve(cli.flags.workspace) : getRepoRoot(),
			{gitlabHost: loadProviderConfigs().vcs_host?.host},
		);
		console.log(
			`Linked ${result.link.url} (${result.link.remoteBranch}) in ${result.file}`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	process.exit(0);
}

checkConfig();

// Load $REPO_ROOT/.envrc (plain `export KEY=VAL` lines) into process.env so
// per-repo Linear credentials and similar reach the providers even when
// pappardelle was launched from a shell or tmux server that didn't have
// direnv hooked. Mirrors STA-1422's idow-level fix one layer up so the TUI's
// bulk GraphQL fetch — which reads LINCTL_API_KEY from process.env — uses
// the right workspace's key instead of falling back to ~/.linctl-auth.json.
// Existing process.env values win; .envrc only fills gaps.
loadEnvrcIntoProcessEnv(getRepoRoot());

// Initialize per-repo state directories so state is kept separate
// from other repos that may also use pappardelle.
const repoName = getRepoName();
const repoStateDir = path.join(homedir(), '.pappardelle', 'repos', repoName);
initForRepo(repoName);
initStateColorCacheDir(repoStateDir);

// Initialize provider singletons from config so that all subsequent
// no-arg calls (e.g. from tracker.ts facade) use the correct provider.
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

if (isRestart) {
	process.exit(restartRepo(repoName, defaultRestartCommandDeps()));
}

// Handle `pappardelle highlight STA-XXX` — write target file and exit
if (cli.input[0] === 'highlight') {
	const issueKey = cli.input[1];
	if (!issueKey) {
		console.error('Usage: pappardelle highlight <issue-key>');
		process.exit(1);
	}

	writeHighlightTarget(repoName, issueKey);
	process.exit(0);
}

// Handle `pappardelle send STA-XXX text` — submit a prompt to a space's Claude
if (cli.input[0] === 'send') {
	const rawKey = cli.input[1];
	let text = cli.input.slice(2).join(' ');
	if (!text && !process.stdin.isTTY) {
		text = readFileSync(0, 'utf8').replace(/\n$/, '');
	}

	if (!rawKey || !text) {
		console.error(
			'Usage: pappardelle send <issue-key> [text]  (or text on stdin)',
		);
		process.exit(1);
	}

	let config;
	try {
		config = loadConfig();
	} catch {
		config = null;
	}

	const issueKey = resolveSpaceKey(
		rawKey,
		config ? getTeamPrefix(config) : 'STA',
		createIssueTracker().name,
		config ? getBeadsPrefixes(config, readBeadsIssuePrefix()) : [],
	);
	const result = sendToSpaceAgent(issueKey, text);
	if (result === 'no-session') {
		const session = getSessionNames(issueKey).agent;
		console.error(
			`No active session for ${issueKey} (${session} on ${INNER_SOCKET})`,
		);
		process.exit(1);
	}

	if (result === 'failed') {
		console.error(`Failed to send to ${issueKey}`);
		process.exit(1);
	}

	process.exit(0);
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
	const normalizedIssueKey = normalizeIssueIdentifier(
		prompt,
		teamPrefix,
		createIssueTracker().name,
		config ? getBeadsPrefixes(config, readBeadsIssuePrefix()) : [],
	);
	const finalPrompt = normalizedIssueKey ?? prompt;

	console.log(`Starting new session with: "${finalPrompt}"`);

	const result = spawnSync(path.join(SCRIPTS_DIR, 'idow'), [finalPrompt], {
		stdio: 'inherit',
		cwd: getRepoRoot(),
		env: buildSpawnEnv(getRepoRoot(), getMainRepoRoot()),
	});

	process.exit(result.status ?? 0);
}

// If not in tmux, re-exec inside tmux
if (!isInTmux() && cli.flags.layout) {
	const repoName = getRepoName();
	const sessionName = outerSessionName(repoName);

	// Check if a pappardelle session already exists
	if (sessionExists(sessionName)) {
		// Attach to the existing session
		const tmuxArgs = ['attach-session', '-t', `=${sessionName}`];
		const result = spawnSync('tmux', tmuxArgs, {
			stdio: 'inherit',
			env: process.env,
		});
		process.exit(result.status ?? 0);
	}

	// No existing session - create a new one.
	const cmd = tuiLaunchCommand({
		execPath: process.execPath,
		cliPath: process.argv[1] ?? 'pappardelle',
		args: process.argv.slice(2),
		home: homedir(),
	});

	const tmuxArgs = ['new-session', '-s', sessionName, cmd];
	const result = spawnSync('tmux', tmuxArgs, {
		stdio: 'inherit',
		env: process.env,
	});
	process.exit(result.status ?? 0);
}

// Set up tmux layout if in tmux and not disabled
let paneLayout: PaneLayout | null = null;

if (isInTmux() && cli.flags.layout) {
	// On startup, kill any leftover claude-{repo}-* / companion-{repo}-* sessions
	// on the default socket from a pre-STA-860 run. tmux can't migrate sessions
	// between servers, so we drop them; idow / Pappardelle recreates them on
	// the inner socket on demand. Runs every startup (fast no-op once drained);
	// the phrasing used to say "one-time migration" but the call is unconditional.
	const killed = cleanupOrphanedOuterSessions();
	if (killed > 0) {
		console.error(
			`\x1b[33mPappardelle: cleared ${killed} stale outer-socket session(s) — they'll be recreated on the inner socket.\x1b[0m`,
		);
	}

	// STE-2: migrate live pre-rename `claude-{repo}-*` sessions to their
	// `agent-{repo}-*` names before the reap below decides what's an orphan —
	// a rename preserves the running conversation, a reap would kill it.
	const migrated = migrateLegacyAgentSessions();
	if (migrated > 0) {
		console.error(
			`\x1b[33mPappardelle: renamed ${migrated} legacy claude-* session(s) to agent-*.\x1b[0m`,
		);
	}

	// STA-1420: also reap inner-socket orphans whose key isn't in the registry
	// and isn't the main worktree. These accumulate when Pappardelle is
	// hard-quit between unregistering and the tmux kill (or when a slow
	// pre_workspace_deinit is Ctrl-C'd mid-flow). Symmetric to the outer reap
	// above; without it, dead `agent-pappa-STA-*` sessions linger forever now
	// that STA-1416 removed seedFromTmux.
	const innerReaped = cleanupOrphanedInnerSessions(
		new Set(getRegisteredSpaces()),
	);
	if (innerReaped > 0) {
		console.error(
			`\x1b[33mPappardelle: reaped ${innerReaped} orphaned inner-socket session(s).\x1b[0m`,
		);
	}

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
// Now that we own the alt screen, stop forwarding intercepted stderr to the
// terminal — a stray subprocess stderr write here corrupts Ink's frame (STA-1496).
// It's still logged + shown in the in-app error overlay. Re-enabled on teardown.
setStderrTerminalPassthrough(false);

// Cleanup on exit
const cleanup = () => {
	// Restore stderr→terminal forwarding before we leave the alt screen so any
	// teardown/exit diagnostics are visible to the user again.
	setStderrTerminalPassthrough(true);
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

// Compute the abbreviated commit SHA of the pappardelle source for display in the help overlay.
// Uses the pappardelle project directory so the SHA only changes when pappardelle code is modified.
let commitSha = 'unknown';
try {
	commitSha = execSync('git log -1 --format=%h -- .', {
		cwd: pappardelleDir,
		encoding: 'utf8',
		stdio: ['pipe', 'pipe', 'pipe'],
	}).trim();
} catch {
	// Not in a git repo or git not available - leave as 'unknown'
}

// Resolve the version for display in the help overlay. A real release checkout
// reports its own vX.Y.Z tag; a dev/worktree build (run from the monorepo, where
// no release tag exists) reports the latest installed release flagged `-dev`;
// neither resolvable → null, and the help line degrades to sha-only (STA-1494).
const {version: installedVersion, isDev: isDevBuild} =
	resolveDisplayVersion(pappardelleDir);

// Kick off the update check asynchronously — never blocks startup, fails silent.
// safeCheckForUpdate swallows all errors, so the promise will only ever
// resolve (never reject). We hand the promise straight to App so render()
// isn't blocked on the network.
const updateCheckPromise = safeCheckForUpdate({projectDir: pappardelleDir});

// Render the app. We feed Ink a CSI-u-normalizing wrapper around stdin so the
// Kitty keyboard protocol (e.g. Esc arriving as `ESC [ 27 u` under tmux
// extended-keys) is translated back to legacy bytes before either Ink's
// `useInput` or our `useRawInput` ever sees it (STA-1545). On a non-TTY stdin
// (no raw keyboard input to normalize) we pass it through untouched.
const inkStdin = process.stdin.isTTY
	? createNormalizingStdin(process.stdin)
	: process.stdin;

renderTui(
	<App
		paneLayout={paneLayout}
		commitSha={commitSha}
		installedVersion={installedVersion}
		isDevBuild={isDevBuild}
		updateCheckPromise={updateCheckPromise}
	/>,
	{stdin: inkStdin},
);
