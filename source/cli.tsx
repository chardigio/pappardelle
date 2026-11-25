#!/usr/bin/env bun
import {routeDrops} from './drop-routing.ts';
import {
	startStartupTrace,
	startupTrace,
	startupSessionEnvArgs,
} from './startup-trace.ts';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {installationRoot, scriptsDir, cliFilePath} from './runtime.ts';
import path from 'node:path';
import {
	cleanupOrphanedInnerSessions,
	liveInnerSessions,
	sharedSessionListingRunner,
	cleanupOrphanedOuterSessions,
	migrateLegacyAgentSessions,
	exactSessionTarget,
	killSession,
	isInTmux,
	sendKeysToSpaceAgent,
	newOuterSessionArgs,
	sendToSpaceAgent,
	type SendToSpaceAgentResult,
	sessionExists,
	setupPappardellLayout,
	enableTmuxControlClients,
	getWorktreePath,
	spaceSessionNames,
	getMainWorktreeInfo,
	INNER_SOCKET,
} from './tmux.ts';
import type {PaneLayout} from './types.ts';
import {
	configExists,
	getRepoRoot,
	getMainRepoRoot,
	getRepoName,
	readConfig,
	DEFAULT_TEAM_PREFIX,
	checkAgentProfile,
	unknownAgentProfileMessage,
	loadProviderConfigs,
	getBeadsPrefixes,
	readBeadsIssuePrefix,
	getTeamPrefix,
	getProfileTeamPrefix,
	validateHomeOnlySqliteState,
} from './config.ts';
import {
	formatConfigErrors,
	ConfigNotFoundError,
	ConfigValidationError,
} from './config-errors.ts';
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
import {cliSpaceKey} from './cli-space-key.ts';
import {buildSpawnEnv} from './spawn-env.ts';
import {
	readCommitSha,
	resolveDisplayVersion,
	safeCheckForUpdate,
} from './update-check.ts';
import {linkPr} from './link-pr.ts';
import {createStateDaos, type StateDaos} from './state-daos.ts';
import {
	defaultCloseCommandDeps,
	runCloseCommand,
	runCloseTeardown,
} from './close-command.ts';
import {parseCli, parseSendArgs, subcommandGate} from './cli-args.ts';
import {callerFromEnv, recordSupervision} from './supervise-log.ts';
import {isSuperviseVerb} from './supervise-args.ts';
import {runOpenSpaceCommand} from './open-space-command.ts';
import {waitForAgentStart} from './agent-start.ts';
import {hookStatusKey} from './claude-status.ts';
import {reviveTui, tuiLaunchCommand, tuiSessionNames} from './tui-sessions.ts';
import {
	readTmuxVersion,
	tmuxTooOldMessage,
	tmuxVersionTooOld,
} from './tmux-version.ts';
import {isTuiDead} from './tui-marker.ts';
import {SEND_LOCK_TIMEOUT_MS} from './send-lock.ts';
import {defaultUpdateCommandDeps, runUpdateCommand} from './update-command.ts';
import {
	defaultRestartCommandDeps,
	hardRestart,
	restartRepo,
} from './restart-command.ts';
import {
	protectedSessionNames,
	mainIdentity,
	spaceWorktreePath,
} from './space-identity.ts';
import {resolveTargetSpace} from './space-target.ts';
import {exitAfterFlush} from './exit-after-flush.ts';

const SCRIPTS_DIR = scriptsDir;
const REARM_SCHEDULES_DELAY_MS = 5000;

const gate = subcommandGate(process.argv.slice(2));
if (gate.action === 'help') {
	console.log(gate.text);
	process.exit(0);
}

if (gate.action === 'reject') {
	console.error(gate.message);
	process.exit(2);
}

// A subcommand's modules load when it runs, so starting the TUI doesn't pay
// for them.
if (process.argv[2] === 'mcp' && process.argv[3] === 'install') {
	const {defaultMcpInstallDeps, installMcpServer} =
		await import('./mcp-install.ts');
	process.exit(installMcpServer(defaultMcpInstallDeps()));
}

if (process.argv[2] === 'mcp') {
	await import('./mcp-cli.ts');
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
	const resolved = cliSpaceKey(
		rawKey,
		readConfig(),
		createIssueTracker().name,
		readBeadsIssuePrefix,
	);
	if (resolved.kind === 'key') return resolved.key;
	console.error(
		`${rawKey} needs team_prefix from .pappardelle.yml, which is invalid:\n${formatConfigErrors(resolved.errors)}`,
	);
	process.exit(1);
}

// Dispatched before meow so that `--field x` and `--field=x` both parse, and
// so that a mistyped verb exits instead of being read as a prompt.
if (process.argv[2] === 'space') {
	const {runSpaceCommand, defaultSpaceCommandDeps} =
		await import('./space-command.ts');
	await exitAfterFlush(
		await runSpaceCommand(
			process.argv.slice(3),
			defaultSpaceCommandDeps({resolveKey: resolveCliSpaceKey}),
		),
	);
}

// Dispatched before meow for the same reasons as `space`.
if (process.argv[2] === 'agent-profile') {
	const {runAgentProfileCommand, defaultAgentProfileCommandDeps} =
		await import('./agent-profile-command.ts');
	await exitAfterFlush(
		runAgentProfileCommand(
			process.argv.slice(3),
			defaultAgentProfileCommandDeps(),
		),
	);
}

// Dispatched before meow, which would read the wrapped command's flags
// (including --help) as Pappardelle's own.
if (process.argv[2] === 'companion') {
	const companionArgv = process.argv.slice(3);
	const {runCompanionCommand} = await import('./companion-command.ts');
	let companionDaos: StateDaos | undefined;
	const bootstrap = () => {
		companionDaos ??= bootstrapRepo().daos;
		return companionDaos;
	};

	await exitAfterFlush(
		await runCompanionCommand(companionArgv, {
			resolveSpace(flag) {
				checkConfig();
				bootstrap();
				return resolveTargetSpace({
					flag,
					env: process.env,
					resolve: resolveCliSpaceKey,
				});
			},
			daos: bootstrap,
		}),
	);
}

// Dispatched before meow for the same reason as `companion`: their flags
// (--keys, --message) would otherwise be read as Pappardelle's own.
if (isSuperviseVerb(process.argv[2])) {
	checkConfig();
	const {daos} = bootstrapRepo();
	const [{runSuperviseCommand}, {defaultSuperviseDeps}] = await Promise.all([
		import('./supervise-command.ts'),
		import('./supervise-runtime.ts'),
	]);
	await exitAfterFlush(
		await runSuperviseCommand(
			process.argv.slice(2),
			defaultSuperviseDeps(resolveCliSpaceKey, daos),
		),
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

if (cli.flags.agentProfile?.trim() === '') {
	console.error('--agent-profile needs an agent profile name');
	process.exit(1);
}

if (cli.flags.agentProfile !== undefined && cli.input.length === 0) {
	console.error(
		'Usage: pappardelle --agent-profile <name> <prompt or issue-key>',
	);
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
	const {daos} = bootstrapRepo();
	process.exit(
		await runCloseTeardown(cli.input[1]!, defaultCloseCommandDeps(daos)),
	);
}

if (process.argv[2] === 'plugin') {
	const {defaultPluginInstallDeps, installPlugin} =
		await import('./plugin-install.ts');
	process.exit(installPlugin(defaultPluginInstallDeps(pappardelleDir)));
}

if (isRestart && cli.flags.hard) {
	process.exit(
		await hardRestart(cli.flags.yes ?? false, defaultRestartCommandDeps()),
	);
}

// Check for .pappardelle.yml config file
function checkConfig(): void {
	let repoRoot: string;
	try {
		repoRoot = getRepoRoot();
	} catch {
		console.error(
			'\x1b[31mError: pappardelle must be run from within a git repository.\x1b[0m',
		);
		console.error(
			'\x1b[33mPlease navigate to a git repository and try again.\x1b[0m',
		);
		process.exit(1);
	}

	try {
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

		validateHomeOnlySqliteState();
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
			console.error(`\x1b[31m${formatConfigErrors(error.errors)}\x1b[0m`);
			console.error('');
			console.error('Please fix the configuration and try again.');
			process.exit(1);
		} else {
			console.error(error instanceof Error ? error.message : String(error));
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
		const providers = loadProviderConfigs();
		// A GitLab host from a layer that failed to parse would link the wrong MR.
		if (providers.layerErrors.length > 0)
			throw new Error(formatConfigErrors(providers.layerErrors));
		const result = await linkPr(
			cli.input[1]!,
			process.cwd(),
			cli.flags.workspace ? path.resolve(cli.flags.workspace) : getRepoRoot(),
			{
				daosFor: repo => createStateDaos({repo}),
				gitlabHost: providers.vcs_host?.host,
			},
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
const {repoName, daos} = bootstrapRepo();
bootstrapDone?.();

if (isRestart) {
	process.exit(await restartRepo(repoName, defaultRestartCommandDeps()));
}

// Handle `pappardelle highlight STA-XXX`: record the request and exit
if (cli.input[0] === 'highlight') {
	const issueKey = cli.input[1];
	if (!issueKey) {
		console.error('Usage: pappardelle highlight <issue-key> [--focus]');
		process.exit(1);
	}

	await daos.highlight.request({
		issueKey,
		focus: cli.flags.focus === true,
	});
	process.exit(0);
}

// Handle `pappardelle send STA-XXX text` — submit a prompt to a space's agent
if (cli.input[0] === 'send') {
	const {
		key: rawKey,
		text: argText,
		keys,
		force,
	} = parseSendArgs(process.argv.slice(2));
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
			'Usage: pappardelle send <issue-key> [--force] [text]  (or text on stdin)\n       pappardelle send <issue-key> --keys <key> [--keys <key>]...',
		);
		process.exit(1);
	}

	const issueKey = resolveCliSpaceKey(rawKey);
	migrateLegacyAgentSessions();
	const result =
		keys.length > 0
			? sendKeysToSpaceAgent(issueKey, keys)
			: await sendToSpaceAgent(issueKey, text, {force});
	recordSupervision(
		getRepoName(),
		callerFromEnv(process.env),
		{
			action: 'send',
			key: issueKey,
			sent: keys.join(' ') || text,
			detail: result,
		},
		new Date(),
	);
	const refusal = sendRefusal(result, issueKey, {typedText: keys.length === 0});
	if (refusal) {
		console.error(refusal);
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
			defaultCloseCommandDeps(daos),
		),
	);
}

if (cli.input[0] === 'spaces') {
	const load = readConfig();
	if (load.kind === 'invalid') {
		console.error(formatConfigErrors(load.errors));
	}

	const {runSpacesCommand} = await import('./spaces-command.ts');
	await exitAfterFlush(
		await runSpacesCommand({
			repoName,
			registry: daos.registry,
			spaceIdentities: daos.spaceIdentities,
			claudeStatus: daos.claudeStatus,
			programStatus: daos.programStatus,
			spaceState: daos.spaceState,
			issueMeta: daos.issueMeta,
			agentSessions: daos.agentSessions,
			config: load.kind === 'valid' ? load.config : null,
			home: homedir(),
			json: cli.flags.json ?? false,
			out: text => console.log(text),
		}),
	);
}

if (cli.input[0] === 'read') {
	const rawKey = cli.input[1];
	if (!rawKey || cli.input.length > 2) {
		console.error('Usage: pappardelle read <issue-key> [--turns N] [--json]');
		process.exit(1);
	}

	const issueKey = resolveCliSpaceKey(rawKey);
	const load = readConfig();
	if (load.kind === 'invalid') {
		console.error(formatConfigErrors(load.errors));
	}

	const {runReadCommand} = await import('./read-command.ts');
	await exitAfterFlush(
		await runReadCommand({
			issueKey,
			worktree: getWorktreePath(issueKey),
			spaceState: daos.spaceState,
			agentSessions: daos.agentSessions,
			config: load.kind === 'valid' ? load.config : null,
			home: homedir(),
			turns: cli.flags.turns,
			json: cli.flags.json ?? false,
			out: text => console.log(text),
			err: text => console.error(text),
		}),
	);
}

// If a prompt is provided as positional argument, spawn idow directly and exit
if (cli.input.length > 0) {
	const prompt = cli.input.join(' ');

	// Normalize issue identifiers (supports bare numbers like '400')
	const load = readConfig();
	if (load.kind === 'invalid') {
		console.error(formatConfigErrors(load.errors));
		process.exit(1);
	}

	const config = load.kind === 'valid' ? load.config : null;
	const {agentProfile} = cli.flags;
	if (agentProfile !== undefined) {
		if (!config) {
			console.error(
				`Could not check agent profile "${agentProfile}": no .pappardelle.yml`,
			);
			process.exit(1);
		}

		const check = checkAgentProfile(config, agentProfile);
		if (check.kind === 'unknown') {
			console.error(unknownAgentProfileMessage(agentProfile, check.names));
			process.exit(1);
		}
	}

	let teamPrefix = config ? getTeamPrefix(config) : DEFAULT_TEAM_PREFIX;
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

	// A space reopened by key resumes its conversation. Its worktree may have
	// no stored identity: it closed before identities were stored.
	const worktreeOnDisk = (key: string | null) => {
		if (!key) return false;
		const found = spaceWorktreePath(
			daos.spaceIdentities,
			homedir(),
			getRepoName(),
			key,
		);
		return found.kind === 'path' && existsSync(found.path);
	};

	const status = await runOpenSpaceCommand({
		command: path.join(SCRIPTS_DIR, 'idow'),
		prompt: finalPrompt,
		issueKey: normalizedIssueKey,
		profileName: cli.flags.profile,
		agentProfileName: agentProfile,
		resume: cli.flags.resume ?? worktreeOnDisk(normalizedIssueKey),
		cwd: getRepoRoot(),
		env: buildSpawnEnv(getRepoRoot(), {
			mainRepoRoot: getMainRepoRoot(),
			registerSpace: daos.registry.keepsLifecycle,
		}),
		registry: daos.registry,
		waitForAgent: cli.flags.wait
			? async (issueKey, since) => {
					const worktree = getWorktreePath(issueKey);
					return (
						worktree !== null &&
						waitForAgentStart({
							claudeStatus: daos.claudeStatus,
							statusKey: hookStatusKey(getRepoName(), issueKey),
							worktree,
							since,
							timeoutMs: 60_000,
							osc: {
								programStatus: daos.programStatus,
								spaceIdentities: daos.spaceIdentities,
								issueKey,
							},
						})
					);
				}
			: undefined,
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
	let existing = tuiSessionNames(repoName).find(name => sessionExists(name));
	const cmd = tuiLaunchCommand({
		execPath: process.execPath,
		cliPath: cliFilePath(),
		args: process.argv.slice(2),
		home: homedir(),
	});

	if (existing !== undefined && isTuiDead(daos.tuiMarker)) {
		const revived = reviveTui({
			session: existing,
			command: cmd,
			cwd: process.cwd(),
			envArgs: startupSessionEnvArgs(),
			markerPaneId: daos.tuiMarker.read()?.paneId ?? null,
		});
		// The session is created again instead, which can race the server's
		// exit when it was the server's last session.
		if (!revived.ok) {
			createLogger('cli').warn(
				`Could not restart the TUI in ${existing}: ${revived.reason}`,
			);
			killSession(existing);
			existing = undefined;
		}
	}

	if (existing !== undefined) {
		outerDone?.();
		startupTrace.current?.finish('delegated');
		const tmuxArgs = ['attach-session', '-t', exactSessionTarget(existing)];
		const result = spawnSync('tmux', tmuxArgs, {
			stdio: 'inherit',
			env: process.env,
		});
		exitWithTmux(result);
	}

	const tmuxArgs = newOuterSessionArgs(repoName, startupSessionEnvArgs(), cmd);
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

async function maintainSessions() {
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
	// The reap below keeps only the sessions of spaces with an identity.
	await daos.spaceIdentities
		.moveMain(
			mainIdentity({
				repo: repoName,
				mainRoot: getMainRepoRoot(),
				env: process.env,
			}),
		)
		.catch((error: unknown) => {
			createLogger('cli').warn(
				"Could not record the main space's identity",
				error instanceof Error ? error : undefined,
			);
		});
	await daos.spaceIdentities.respellFormatSessions().catch((error: unknown) => {
		createLogger('cli').warn(
			'Could not respell stored session names',
			error instanceof Error ? error : undefined,
		);
	});
	// A space left half-opened or half-closed by a process that died is
	// settled by whether its sessions exist, before deciding what to reap.
	await daos.registry
		.settle({
			closing: new Set(),
			liveSessions: () => liveInnerSessions(innerTmux),
		})
		.catch((error: unknown) => {
			createLogger('cli').warn(
				'Could not settle unfinished spaces at startup',
				error instanceof Error ? error : undefined,
			);
		});
	const owned = protectedSessionNames(daos.registry, daos.spaceIdentities);
	if (owned.kind === 'unreadable') {
		// An unreadable registry is not an empty one: reaping against it
		// would kill every session of every open space.
		reapingDone?.();
		createLogger('cli').warn(
			'Skipped the inner-socket reap: the spaces or their names could not be read',
			owned.error instanceof Error ? owned.error : undefined,
		);
		return;
	}

	if (owned.kind === 'missing') {
		reapingDone?.();
		createLogger('cli').warn(
			`Skipped the inner-socket reap: no stored session names for ${owned.keys.join(', ')}`,
		);
		return;
	}

	const innerReaped = cleanupOrphanedInnerSessions(owned, undefined, innerTmux);
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
	const registry = daos.registry.openSpacesAsync();
	// App reports a failed read when it takes this over.
	registry.catch(() => null);
	return {registry, mainWorktree: getMainWorktreeInfo()};
}

// From here this process renders the TUI. The CLI verbs above exit first.
daos.deferCheckpoints();
daos.allowStatusDaemonStart();
const initialWorkspaces = startWorkspaceReads();

// tmux splits the panes while the renderer's modules load below.
let layoutSetup: ReturnType<typeof setupPappardellLayout> | undefined;
if (isInTmux() && cli.flags.layout) {
	await maintainSessions();
	enableTmuxControlClients();
	layoutSetup = setupPappardellLayout();
}

function readDisplayMetadata() {
	const commitDone = startupTrace.current?.begin('commit-metadata');
	const sha = readCommitSha(pappardelleDir);
	commitDone?.(sha === undefined ? 'unavailable' : 'ok');
	const commitSha = sha ?? 'unknown';

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
	void safeCheckForUpdate({
		projectDir: pappardelleDir,
		cache: daos.updateCheck,
	}).then(finishUpdate);
	// Wake-ups lost to a reboot can wait; loading this while the first
	// workspace attaches would hold that up.
	setTimeout(() => {
		void import('./supervise-runtime.ts').then(async ({rearmSchedules}) => {
			await rearmSchedules(daos.schedules);
		});
	}, REARM_SCHEDULES_DELAY_MS);
}
const app = () => (
	<App
		daos={daos}
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

/** What `pappardelle send` prints when the send did not go through. */
function sendRefusal(
	result: SendToSpaceAgentResult,
	issueKey: string,
	{typedText}: {typedText: boolean},
): string | undefined {
	switch (result) {
		case 'sent': {
			return undefined;
		}

		case 'prompt': {
			return `Not sent: ${issueKey} is showing a permission prompt, a question or a Codex dialog. Answer it with \`pappardelle answer ${issueKey}\`; Escape can still be pressed on a prompt or question`;
		}

		case 'draft': {
			return `Not sent: ${issueKey}'s input box has text that sending would clear. Check it with \`pappardelle screen ${issueKey}\`, or pass --force`;
		}

		case 'unsubmitted': {
			return `Not submitted: the text is in ${issueKey}'s input box but two Enters did not send it. Check it with \`pappardelle screen ${issueKey}\` before sending again`;
		}

		case 'no-session': {
			const session = spaceSessionNames(issueKey)?.agent;
			return session
				? `No active session for ${issueKey} (${session} on ${INNER_SOCKET})`
				: `No active session for ${issueKey}: it has no stored session names`;
		}

		case 'busy': {
			return `Not sent: another send to ${issueKey} is still running after ${SEND_LOCK_TIMEOUT_MS / 1000}s`;
		}

		case 'failed': {
			return typedText
				? `Failed to send to ${issueKey}. The text may still have reached its input box: check it with \`pappardelle screen ${issueKey}\``
				: `Failed to press keys in ${issueKey}`;
		}
	}
}
