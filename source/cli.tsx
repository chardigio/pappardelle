#!/usr/bin/env bun
import {routeDrops} from './drop-routing.ts';
import {
	startStartupTrace,
	startupTrace,
	startupSessionEnvArgs,
} from './startup-trace.ts';
import {execSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {installationRoot, scriptsDir, cliFilePath} from './runtime.ts';
import path from 'node:path';
import {
	cleanupOrphanedInnerSessions,
	sharedSessionListingRunner,
	cleanupOrphanedOuterSessions,
	migrateLegacyAgentSessions,
	exactSessionTarget,
	isInTmux,
	outerSessionName,
	sendKeysToSpaceAgent,
	sendToSpaceAgent,
	sessionExists,
	setupPappardellLayout,
	enableTmuxControlClients,
	getSessionNames,
	getWorktreePath,
	getMainWorktreeInfo,
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
	getProfileTeamPrefix,
	ConfigNotFoundError,
	ConfigValidationError,
} from './config.ts';
import {
	captureStderr,
	setStderrTerminalPassthrough,
	createLogger,
} from './logger.ts';

// Capture stderr early so OpenTUI/React rendering errors go to the log file
captureStderr();
import {bootstrapRepo} from './repo-bootstrap.ts';
import {createIssueTracker} from './providers/index.ts';
import {normalizeIssueIdentifier} from './issue-checker.ts';
import {resolveSpaceKey} from './issue-utils.ts';
import {buildSpawnEnv} from './spawn-env.ts';
import {
	getRegisteredSpaces,
	getRegisteredSpacesAsync,
} from './space-registry.ts';
import {writeHighlightTarget} from './highlight.ts';
import {resolveDisplayVersion, safeCheckForUpdate} from './update-check.ts';
import {linkPr} from './link-pr.ts';
import {
	defaultCloseCommandDeps,
	runCloseCommand,
	runCloseTeardown,
} from './close-command.ts';
import {defaultPluginInstallDeps, installPlugin} from './plugin-install.ts';
import {parseCli, parseSendArgs, subcommandGate} from './cli-args.ts';
import {runOpenSpaceCommand} from './open-space-command.ts';
import {tuiLaunchCommand} from './tui-sessions.ts';
import {
	readTmuxVersion,
	tmuxTooOldMessage,
	tmuxVersionTooOld,
} from './tmux-version.ts';
import {DEFAULT_REPO_STATE_ROOT, isTuiDead} from './tui-marker.ts';
import {SEND_LOCK_TIMEOUT_MS} from './send-lock.ts';
import {defaultUpdateCommandDeps, runUpdateCommand} from './update-command.ts';
import {
	defaultRestartCommandDeps,
	hardRestart,
	restartRepo,
} from './restart-command.ts';
import {runCompanionCommand} from './companion-command.ts';
import {resolveTargetSpace} from './space-target.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {findLatestSessionJsonl} from './space-state.ts';
import {formatTurns, readTurns, turnsJson} from './read-command.ts';
import {
	formatSpaces,
	gatherSpaces,
	worktreeGitSummary,
} from './spaces-command.ts';
import {getIssues} from './tracker.ts';

const SCRIPTS_DIR = scriptsDir;

const gate = subcommandGate(process.argv.slice(2));
if (gate.action === 'help') {
	console.log(gate.text);
	process.exit(0);
}

if (gate.action === 'reject') {
	console.error(gate.message);
	process.exit(2);
}

// Hooks and config resolve from the repo root the way they do in the TUI,
// which runs from the main checkout, not from the worktree being closed.
if (process.argv[2] === 'close') {
	try {
		process.chdir(getMainRepoRoot());
	} catch {
		// Outside a git repo; checkConfig reports it.
	}
}

function resolveCliSpaceKey(rawKey: string): string {
	let config;
	try {
		config = loadConfig();
	} catch {
		config = null;
	}

	return resolveSpaceKey(
		rawKey,
		config ? getTeamPrefix(config) : 'STA',
		createIssueTracker().name,
		config ? getBeadsPrefixes(config, readBeadsIssuePrefix()) : [],
	);
}

// Dispatched before meow, which would read the wrapped command's flags
// (including --help) as Pappardelle's own.
if (process.argv[2] === 'companion') {
	const companionArgv = process.argv.slice(3);
	process.exit(
		await runCompanionCommand(companionArgv, {
			resolveSpace(flag) {
				checkConfig();
				bootstrapRepo();
				return resolveTargetSpace({
					flag,
					env: process.env,
					resolve: resolveCliSpaceKey,
				});
			},
			repoName: getRepoName,
		}),
	);
}

const cli = parseCli();

if (
	cli.flags.profile !== undefined &&
	(!cli.flags.profile.trim() || cli.input.length === 0)
) {
	console.error('Usage: pappardelle --profile <name> <prompt or issue-key>');
	process.exit(1);
}

if (cli.flags.resume && cli.input.length === 0) {
	console.error('Usage: pappardelle --resume <prompt or issue-key>');
	process.exit(1);
}

const pappardelleDir = installationRoot;

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

// The detached half of a self-close. Its cwd is the main repo root and its key
// is already resolved, and the worktree it was asked from may be gone.
if (cli.input[0] === 'close' && cli.flags.teardownOnly) {
	if (cli.input.length !== 2) process.exit(1);
	bootstrapRepo();
	process.exit(
		await runCloseTeardown(cli.input[1]!, defaultCloseCommandDeps()),
	);
}

if (process.argv[2] === 'plugin') {
	process.exit(installPlugin(defaultPluginInstallDeps(pappardelleDir)));
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

if (cli.input.length === 0) {
	startStartupTrace();
	createLogger('cli').info('Pappardelle starting');
}
const configurationDone = startupTrace.current?.begin('configuration');
checkConfig();
configurationDone?.();

const bootstrapDone = startupTrace.current?.begin('repo-bootstrap');
const {repoName} = bootstrapRepo();
bootstrapDone?.();

if (isRestart) {
	process.exit(await restartRepo(repoName, defaultRestartCommandDeps()));
}

// Handle `pappardelle highlight STA-XXX` — write target file and exit
if (cli.input[0] === 'highlight') {
	const issueKey = cli.input[1];
	if (!issueKey) {
		console.error('Usage: pappardelle highlight <issue-key> [--focus]');
		process.exit(1);
	}

	writeHighlightTarget(repoName, {
		issueKey,
		focus: cli.flags.focus === true,
	});
	process.exit(0);
}

// Handle `pappardelle send STA-XXX text` — submit a prompt to a space's agent
if (cli.input[0] === 'send') {
	const {key: rawKey, text: argText, keys} = parseSendArgs(process.argv.slice(2));
	let text = argText;
	if (keys.length > 0 && text) {
		console.error('Pass text or --keys, not both');
		process.exit(1);
	}

	if (!text && keys.length === 0 && !process.stdin.isTTY) {
		text = readFileSync(0, 'utf8').replace(/\n$/, '');
	}

	if (!rawKey || (!text && keys.length === 0)) {
		console.error(
			'Usage: pappardelle send <issue-key> [text]  (or text on stdin)\n       pappardelle send <issue-key> --keys <key> [--keys <key>]...',
		);
		process.exit(1);
	}

	const issueKey = resolveCliSpaceKey(rawKey);
	migrateLegacyAgentSessions();
	const result =
		keys.length > 0
			? sendKeysToSpaceAgent(issueKey, keys)
			: await sendToSpaceAgent(issueKey, text);
	if (result === 'no-session') {
		const session = getSessionNames(issueKey).agent;
		console.error(
			`No active session for ${issueKey} (${session} on ${INNER_SOCKET})`,
		);
		process.exit(1);
	}

	if (result === 'busy') {
		console.error(
			`Not sent: another send to ${issueKey} is still running after ${SEND_LOCK_TIMEOUT_MS / 1000}s`,
		);
		process.exit(1);
	}

	if (result === 'failed') {
		console.error(`Failed to send to ${issueKey}`);
		process.exit(1);
	}

	process.exit(0);
}

if (cli.input[0] === 'close') {
	const rawKey = cli.input[1];
	if (!rawKey || cli.input.length !== 2) {
		console.error('Usage: pappardelle close <issue-key> [--yes]');
		process.exit(1);
	}

	const issueKey = resolveCliSpaceKey(rawKey);
	process.exit(
		await runCloseCommand(
			{key: issueKey, yes: cli.flags.yes ?? false},
			defaultCloseCommandDeps(),
		),
	);
}

if (cli.input[0] === 'spaces') {
	const report = await gatherSpaces({
		repoName,
		home: homedir(),
		async fetchTitles(keys) {
			const issues = await getIssues(keys);
			return new Map(
				[...issues].map(([key, issue]) => [key, issue?.title ?? null]),
			);
		},
		gitSummary: worktreeGitSummary,
	});
	console.log(
		cli.flags.json ? JSON.stringify(report, null, 2) : formatSpaces(report),
	);
	process.exit(0);
}

if (cli.input[0] === 'read') {
	const rawKey = cli.input[1];
	const turns = cli.flags.turns ?? 5;
	if (
		!rawKey ||
		cli.input.length > 2 ||
		!Number.isInteger(turns) ||
		turns < 1
	) {
		console.error('Usage: pappardelle read <issue-key> [--turns N] [--json]');
		process.exit(1);
	}

	const issueKey = resolveCliSpaceKey(rawKey);
	const worktree =
		issueKey === MAIN_WORKTREE_KEY
			? getMainRepoRoot()
			: getWorktreePath(issueKey);
	const log = worktree ? await findLatestSessionJsonl(worktree) : null;
	if (!log) {
		console.error(`No conversation log for ${issueKey}`);
		process.exit(1);
	}

	const parsed = readTurns(log);
	console.log(
		cli.flags.json
			? JSON.stringify(turnsJson(issueKey, parsed, turns), null, 2)
			: formatTurns(issueKey, parsed, turns),
	);
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

	let teamPrefix = config ? getTeamPrefix(config) : 'STA';
	const profile = cli.flags.profile
		? config?.profiles[cli.flags.profile]
		: undefined;
	if (config && profile) teamPrefix = getProfileTeamPrefix(profile, config);
	const normalizedIssueKey = normalizeIssueIdentifier(
		prompt,
		teamPrefix,
		createIssueTracker().name,
		config ? getBeadsPrefixes(config, readBeadsIssuePrefix()) : [],
	);
	const finalPrompt = normalizedIssueKey ?? prompt;

	console.log(`Starting new session with: "${finalPrompt}"`);

	const status = await runOpenSpaceCommand({
		command: path.join(SCRIPTS_DIR, 'idow'),
		prompt: finalPrompt,
		issueKey: normalizedIssueKey,
		profileName: cli.flags.profile,
		resume:
			cli.flags.resume ??
			Boolean(normalizedIssueKey && getWorktreePath(normalizedIssueKey)),
		cwd: getRepoRoot(),
		env: buildSpawnEnv(getRepoRoot(), getMainRepoRoot()),
	});

	process.exit(status);
}

function exitWithTmux(result: ReturnType<typeof spawnSync>): never {
	if (result.error) {
		console.error(`Could not run tmux: ${result.error.message}`);
		process.exit(1);
	}

	process.exit(result.status ?? 0);
}

// Checked before the re-exec, where the message stays on screen; inside the
// new session it would vanish with the pane.
const tmuxVersionDone = startupTrace.current?.begin('tmux-version');
const tmuxVersion = await readTmuxVersion();
tmuxVersionDone?.();
if (tmuxVersion && tmuxVersionTooOld(tmuxVersion.version)) {
	const [headline, ...details] = tmuxTooOldMessage(tmuxVersion);
	console.error(`\x1b[31m${headline}\x1b[0m`);
	for (const line of details) console.error(line);
	process.exit(1);
}

// If not in tmux, re-exec inside tmux
if (!isInTmux() && cli.flags.layout) {
	const outerDone = startupTrace.current?.begin('outer-bootstrap');
	const repoName = getRepoName();
	const sessionName = outerSessionName(repoName);

	if (
		sessionExists(sessionName) &&
		isTuiDead(DEFAULT_REPO_STATE_ROOT, repoName)
	) {
		spawnSync('tmux', ['kill-session', '-t', exactSessionTarget(sessionName)]);
	}

	// Check if a pappardelle session already exists
	if (sessionExists(sessionName)) {
		// Attach to the existing session
		outerDone?.();
		startupTrace.current?.finish('delegated');
		const tmuxArgs = ['attach-session', '-t', exactSessionTarget(sessionName)];
		const result = spawnSync('tmux', tmuxArgs, {
			stdio: 'inherit',
			env: process.env,
		});
		exitWithTmux(result);
	}

	// No existing session - create a new one.
	const cmd = tuiLaunchCommand({
		execPath: process.execPath,
		cliPath: cliFilePath(),
		args: process.argv.slice(2),
		home: homedir(),
	});

	// The rail's header already names the repo, so the user's status bar would
	// only repeat it.
	const tmuxArgs = [
		'new-session',
		'-s',
		sessionName,
		...startupSessionEnvArgs(),
		cmd,
		';',
		'set-option',
		'-t',
		exactSessionTarget(sessionName),
		'status',
		'off',
	];
	outerDone?.();
	startupTrace.current?.finish('delegated');
	exitWithTmux(
		spawnSync('tmux', tmuxArgs, {
			stdio: 'inherit',
			env: process.env,
		}),
	);
}

// Set up tmux layout if in tmux and not disabled
let paneLayout: PaneLayout | null = null;

function maintainSessions() {
	// On startup, kill any leftover claude-{repo}-* / companion-{repo}-* sessions
	// on the default socket from a pre-STA-860 run. tmux can't migrate sessions
	// between servers, so we drop them; idow / Pappardelle recreates them on
	// the inner socket on demand. Runs every startup (fast no-op once drained);
	// the phrasing used to say "one-time migration" but the call is unconditional.
	const cleanupDone = startupTrace.current?.begin('outer-cleanup');
	const killed = cleanupOrphanedOuterSessions();
	cleanupDone?.();
	if (killed > 0) {
		console.error(
			`\x1b[33mPappardelle: cleared ${killed} stale outer-socket session(s) — they'll be recreated on the inner socket.\x1b[0m`,
		);
	}

	// Migrate live legacy `claude-{repo}-*` sessions to their
	// `agent-{repo}-*` names before the reap below decides what's an orphan —
	// a rename preserves the running conversation, a reap would kill it.
	// Each rename is logged at info; stderr would list them as TUI errors.
	const migrationDone = startupTrace.current?.begin('legacy-migration');
	const innerTmux = sharedSessionListingRunner();
	migrateLegacyAgentSessions(undefined, innerTmux);
	migrationDone?.();

	// STA-1420: also reap inner-socket orphans whose key isn't in the registry
	// and isn't the main worktree. These accumulate when Pappardelle is
	// hard-quit between unregistering and the tmux kill (or when a slow
	// pre_workspace_deinit is Ctrl-C'd mid-flow). Symmetric to the outer reap
	// above; without it, dead `agent-pappa-STA-*` sessions linger forever now
	// that STA-1416 removed seedFromTmux.
	const reapingDone = startupTrace.current?.begin('inner-reaping');
	const innerReaped = cleanupOrphanedInnerSessions(
		new Set(getRegisteredSpaces()),
		undefined,
		innerTmux,
	);
	reapingDone?.();
	if (innerReaped > 0) {
		console.error(
			`\x1b[33mPappardelle: reaped ${innerReaped} orphaned inner-socket session(s).\x1b[0m`,
		);
	}
}
let finishFirstRailPaint: () => void;
const firstRailPaint = new Promise<void>(resolve => {
	finishFirstRailPaint = resolve;
});

// Read while tmux and the renderer are set up, for the first list the rail
// draws.
function startWorkspaceReads() {
	const registry = getRegisteredSpacesAsync();
	// App reports a failed read when it takes this over.
	registry.catch(() => null);
	return {registry, mainWorktree: getMainWorktreeInfo()};
}

const initialWorkspaces = startWorkspaceReads();

// tmux splits the panes while the renderer's modules load below.
let layoutSetup: ReturnType<typeof setupPappardellLayout> | undefined;
if (isInTmux() && cli.flags.layout) {
	maintainSessions();
	enableTmuxControlClients();
	layoutSetup = setupPappardellLayout();
}

function readDisplayMetadata() {
	// Compute the abbreviated commit SHA of the pappardelle source for display in the help overlay.
	// Uses the pappardelle project directory so the SHA only changes when pappardelle code is modified.
	let commitSha = 'unknown';
	const commitDone = startupTrace.current?.begin('commit-metadata');
	try {
		commitSha = execSync('git log -1 --format=%h -- .', {
			cwd: pappardelleDir,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
	} catch {
		// Not in a git repo or git not available - leave as 'unknown'
	} finally {
		commitDone?.(commitSha === 'unknown' ? 'unavailable' : 'ok');
	}

	// Resolve the version for display in the help overlay. A real release checkout
	// reports its own vX.Y.Z tag; a dev/worktree build (run from the monorepo, where
	// no release tag exists) reports the latest installed release flagged `-dev`;
	// neither resolvable → null, and the help line degrades to sha-only (STA-1494).
	const versionDone = startupTrace.current?.begin('version-metadata');
	const {version: installedVersion, isDev: isDevBuild} =
		resolveDisplayVersion(pappardelleDir);
	versionDone?.();

	return {commitSha, installedVersion, isDevBuild};
}
let metadata = {
	commitSha: 'unknown',
	installedVersion: null as string | null,
	isDevBuild: true,
};
let finishUpdate: (
	info: Awaited<ReturnType<typeof safeCheckForUpdate>>,
) => void;
const updateCheckPromise = new Promise<
	Awaited<ReturnType<typeof safeCheckForUpdate>>
>(resolve => {
	finishUpdate = resolve;
});

const importsDone = startupTrace.current?.begin('renderer-imports');
const [{renderTui, rendererExitSignals}, {default: App, quitTui}] =
	await Promise.all([import('./render-tui.ts'), import('./app.tsx')]).catch(
		(error: unknown) => {
			importsDone?.('failed');
			throw error;
		},
	);
importsDone?.();
if (layoutSetup) {
	paneLayout = await layoutSetup;
	if (!paneLayout) {
		console.error(
			'\x1b[33mWarning: Failed to set up tmux pane layout. Running in standalone mode.\x1b[0m',
		);
	}
}

// OpenTUI owns terminal modes and restores them during renderer teardown.
setStderrTerminalPassthrough(false);
process.on('exit', () => {
	setStderrTerminalPassthrough(true);
	// OpenTUI turns on grapheme clustering (mode 2027) and leaves it on at exit.
	if (process.stdout.isTTY) process.stdout.write('\u001B[?2027l');
});

const rendererDone = startupTrace.current?.begin('renderer');
let railPainted = false;
// The rail has rows to act on only once its list is drawn.
const railReady = Promise.withResolvers<void>();
function finishStartup() {
	if (railPainted) return;
	railPainted = true;
	railReady.resolve();
	finishFirstRailPaint();
	metadata = readDisplayMetadata();
	rerender(app());
	void safeCheckForUpdate({projectDir: pappardelleDir}).then(finishUpdate);
}
const app = () => (
	<App
		paneLayout={paneLayout}
		{...metadata}
		updateCheckPromise={updateCheckPromise}
		initialWorkspaces={initialWorkspaces}
		firstRailPaint={firstRailPaint}
		onFirstRailPaint={finishStartup}
	/>
);
const {renderer, rerender} = await renderTui(
	app(),
	{exitOnCtrlC: false, exitSignals: rendererExitSignals},
	renderer => {
		quitTui(renderer, repoName, paneLayout);
	},
	railReady.promise,
);
rendererDone?.();

const [tmuxSocket] = (process.env['TMUX'] ?? '').split(',');
const railPaneId = process.env['TMUX_PANE'];
if (tmuxSocket && railPaneId)
	routeDrops(renderer, {
		socket: tmuxSocket,
		paneId: railPaneId,
		isFocused: true,
	});

await renderer.closed;
process.exit(0);
