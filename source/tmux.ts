// Tmux session attachment for pappardelle
// Attaches to existing agent-STA-XXX and companion-STA-XXX sessions created by idow
import {exec, execFile, execSync, spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type AsyncTmuxRunner = (args: string[]) => Promise<string>;

// The command that starts a tmux server sets the server's working directory.
// Started from a worktree that is later removed, tmux next-3.9 starts every
// later session in that deleted directory, even with -c.
const TMUX_SERVER_CWD = homedir();

const tmuxTimeoutMs = (args: string[]) =>
	args.includes('new-session') ? 10_000 : 5000;

const runTmuxProcess: AsyncTmuxRunner = async args => {
	const {stdout} = await execFileAsync('tmux', args, {
		cwd: TMUX_SERVER_CWD,
		encoding: 'utf-8',
		timeout: tmuxTimeoutMs(args),
	});
	return stdout;
};

// One control-mode client per tmux server, keyed by the socket flags a call
// carries. A server that refuses one is left to processes.
const controlClients = new Map<string, TmuxControlClient | null>();
let controlClientsEnabled = false;

/**
 * Send this process's tmux commands over long-lived control-mode clients
 * instead of a `tmux` process each. For the TUI, which sends them for as long
 * as it runs; a one-shot subcommand has nothing to gain from a second client.
 */
export function enableTmuxControlClients(): void {
	controlClientsEnabled = true;
}
const CONTROL_FLAGS = 'ignore-size,no-output';

function controlClient(server: string[]): TmuxControlClient | undefined {
	const key = server.join(' ');
	let client = controlClients.get(key);
	if (client === undefined) {
		const pane = process.env['TMUX_PANE'];
		if (server.length === 0 && !(process.env['TMUX'] && pane)) {
			client = null;
		} else {
			// The rail's own session is there to join on its server. Any other
			// server gets a session that lasts exactly as long as this client.
			const session = `pappardelle-control-${process.pid}`;
			client = new TmuxControlClient(
				server.length === 0
					? ['-C', 'attach-session', '-f', CONTROL_FLAGS, '-t', pane!]
					: [
							...server,
							'-C',
							'new-session',
							'-f',
							CONTROL_FLAGS,
							'-s',
							session,
							'tail -f /dev/null',
							';',
							'set-option',
							'-t',
							exactSessionTarget(session),
							'destroy-unattached',
							'on',
						],
				{cwd: TMUX_SERVER_CWD},
			);
		}

		controlClients.set(key, client);
	}

	if (client && !client.usable) {
		controlClients.set(key, null);
		return undefined;
	}

	return client ?? undefined;
}

const runTmux: AsyncTmuxRunner = async args => {
	const hasSocket = args[0] === '-L' || args[0] === '-S';
	const server = hasSocket ? args.slice(0, 2) : [];
	const command = controlCommandLine(hasSocket ? args.slice(2) : args);
	const client =
		controlClientsEnabled && command !== undefined
			? controlClient(server)
			: undefined;
	if (!client) return runTmuxProcess(args);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			client.run(command!),
			new Promise<string>((_resolve, reject) => {
				timer = setTimeout(() => {
					// A client that stops answering is not asked again.
					client.stop();
					reject(new Error(`tmux did not answer: ${args.join(' ')}`));
				}, tmuxTimeoutMs(args));
			}),
		]);
	} catch (error) {
		// A tmux too old for the client's flags refuses it after the first
		// commands are already queued.
		if (error instanceof ControlClientNeverStarted)
			return await runTmuxProcess(args);
		throw error;
	} finally {
		clearTimeout(timer);
	}
};
import {
	DEFAULT_COMPANION_COMMAND,
	bindResumeArgs,
	DEFAULT_RESOLVED_AGENT_PROFILE,
	getAgentProfile,
	getNamedAgentProfile,
	resolveAgentProfileName,
	renderAgentLaunchFlags,
	getCompanionCommand,
	quoteLaunchValue,
	getDangerouslySkipPermissions,
	getMainRepoRoot,
	getListLayout,
	getPaneWidths,
	getRepoName,
	loadConfig,
	type PappardelleConfig,
	type ResolvedAgentProfile,
} from './config.ts';
import {createLogger} from './logger.ts';
import {
	ControlClientNeverStarted,
	TmuxControlClient,
	controlCommandLine,
} from './tmux-control.ts';
import {
	CLIENT_TTY_OPTION,
	FRAME_COMMAND_OPTION,
	PANE_TITLE_OPTION,
	frameReadyChannel,
	frameStartedChannel,
} from './pane-frame-options.ts';
import {bunIsolationArgs, isStandalone} from './runtime.ts';
import {startupTrace} from './startup-trace.ts';
import type {PaneLayout} from './types.ts';
import {
	paneGeometryArgs,
	parseWindowGeometry,
	paneGeometry,
	type WindowGeometry,
} from './tmux-geometry.ts';
import {sameFile} from './same-file.ts';
import {SendLockTimeout, withSendLock} from './send-lock.ts';
import {shellQuote} from './shell-quote.ts';
import {buildAgentSessionEnvArgs, buildSessionEnvArgs} from './spawn-env.ts';
import {
	getRegisteredSpaces,
	isSpaceRegistered,
	listKnownRepos,
} from './space-registry.ts';
import {QaSimulatorCleanup} from './qa-simulator.ts';
import {
	getAgentSessionsPath,
	readAgentSession,
	latestAgentProfile,
	readSpaceState,
} from './space-state.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {
	calculateIdealListHeightForCount,
	calculateLayoutForSize,
	MIN_COMPANION_WIDTH,
	NARROW_SCREEN_THRESHOLD,
	type LayoutConfig,
	type PaneWidths,
} from './layout-sizing.ts';
import {nextWidthOverride, type WindowSize} from './pane-drag.ts';
import {
	attachStatusMonitor,
	removeProgramSnapshots,
	statusSocket,
	statusTmuxArgs,
} from './program-status-monitor.ts';

// Re-export sizing constants and functions for external use
export {
	calculateIdealListHeightForCount,
	calculateLayoutForSize,
	NARROW_SCREEN_THRESHOLD,
	MIN_LIST_WIDTH,
	MIN_CLAUDE_WIDTH,
	MIN_COMPANION_WIDTH,
	MIN_RAIL_OVERRIDE_WIDTH,
	MAX_LIST_HEIGHT,
	DEFAULT_MIN_LIST_HEIGHT,
	type LayoutConfig,
} from './layout-sizing.ts';

const log = createLogger('tmux');

// Dedicated tmux socket for per-issue claude/companion sessions. The root
// `pappardelle-{repo}` session and its layout panes stay on the default
// socket; everything the viewer panes attach to lives here. Routing inner
// sessions onto a distinct socket lets the nested attach succeed without
// `TMUX=`, which in turn lets `$TMUX` propagate correctly to subprocesses
// like Claude Code's Agent Teams feature. Must match PAPPARDELLE_TMUX_SOCKET
// in _dev/scripts/dow/*.sh — the two sides have to agree.
export const INNER_SOCKET = 'pappardelle_inner';

/**
 * Prefix `['-L', INNER_SOCKET, ...]` onto a tmux argv. Every inner-session
 * call site must route through this helper so the -L flag can't be forgotten.
 */
export function innerTmuxArgs(args: readonly string[]): string[] {
	return statusTmuxArgs([...args]);
}

// Session naming convention (matches idow)
// Sessions are repo-qualified: agent-{repoName}-{key}, e.g. agent-pappa-chex-CHEX-313

/**
 * tmux 3.6 and older store `.` and `:` in a session name as `_`, so the repo
 * part of a session name is spelled this way to read back the same on every
 * release.
 */
export function tmuxSessionRepo(repoName: string): string {
	return repoName.replaceAll(/[.:]/g, '_');
}

/**
 * Get the session prefix for a given type and repo name.
 * e.g. getSessionPrefix('agent', 'pappa-chex') → 'agent-pappa-chex-'
 */
export function getSessionPrefix(
	type: 'agent' | 'companion',
	repoName?: string,
): string {
	const repo = repoName ?? getRepoName();
	return `${type}-${tmuxSessionRepo(repo)}-`;
}

/**
 * Session prefix used for the agent pane before it was renamed to `agent-`.
 * Live sessions carrying this prefix are renamed in place when the TUI starts,
 * before `pappardelle send`, and when idow opens the space (see
 * `migrateLegacyAgentSessions` and start-agent-session.sh). The orphan reapers
 * sweep it alongside the current prefixes.
 */
export function getLegacyAgentSessionPrefix(repoName?: string): string {
	const repo = repoName ?? getRepoName();
	return `claude-${tmuxSessionRepo(repo)}-`;
}

/**
 * Extract the space key from a repo-qualified session name.
 * e.g. extractIssueKeyFromSession('agent-pappa-chex-CHEX-313', 'pappa-chex') → 'CHEX-313'
 * Returns null if the session doesn't match the expected prefix.
 */
export function extractIssueKeyFromSession(
	sessionName: string,
	repoName?: string,
): string | null {
	const prefix = getSessionPrefix('agent', repoName);
	if (!sessionName.startsWith(prefix)) return null;
	return fromSessionKey(sessionName.slice(prefix.length));
}

// Track which space is currently being viewed
let currentlyViewingSpace: string | null = null;

// Track if panes have active nested tmux clients (vs just shell)
let agentViewerHasClient = false;
let companionViewerHasClient = false;

// Cache pane TTYs for fast client switching
let agentViewerTty: string | null = null;
let companionViewerTty: string | null = null;
let viewerPaneIds: string | null = null;

/**
 * Side-pane widths the user set by hand, or null while the configured or
 * derived width still applies.
 *
 * Module state on purpose: STA-2040 asks for the choice to hold for the rest of
 * the session and for every new pappardelle to open at the default, and process
 * lifetime is exactly that. `rebuildLayout` must not clear them, because
 * crossing the narrow/wide threshold and coming back is not the user changing
 * their mind.
 */
let railWidthOverride: number | null = null;
let companionWidthOverride: number | null = null;

/**
 * Window size and measured side-pane widths at the end of the previous
 * relayout.
 *
 * Together they let `nextWidthOverride` separate a window resize from a
 * hand-drag of a pane border. Measured, not requested, so tmux rounding never
 * reads as a drag.
 */
let lastWindowSize: WindowSize | null = null;
let lastRailWidth: number | null = null;
let lastCompanionWidth: number | null = null;

let configuredPaneWidths: PaneWidths | undefined;

function getConfiguredPaneWidths(): PaneWidths {
	if (configuredPaneWidths === undefined) {
		try {
			configuredPaneWidths = getPaneWidths(loadConfig());
		} catch {
			configuredPaneWidths = {};
		}
	}

	return configuredPaneWidths;
}

let configuredListLines: 1 | 2 | undefined;

/** Replaces the configured list layout, or reads it again when undefined. */
export function setConfiguredListLines(lines: 1 | 2 | undefined): void {
	configuredListLines = lines;
}
function getConfiguredListLines(): 1 | 2 {
	if (configuredListLines === undefined) {
		try {
			configuredListLines = getListLayout(loadConfig()) === 'two_line' ? 2 : 1;
		} catch {
			configuredListLines = 1;
		}
	}

	return configuredListLines;
}

/**
 * Check if running inside tmux
 */
export function isInTmux(): boolean {
	return Boolean(process.env['TMUX']);
}

/**
 * A tmux target that only matches a session with exactly this name. A bare
 * name falls back to prefix matching when no session has it exactly, so a
 * lookup or kill for STA-1 would hit STA-12, and `pappardelle-pappa` would hit
 * `pappardelle-pappa-chex`. The trailing `:` ends the session part, so a `.` in
 * the repo name is not read as a window or pane separator.
 */
export function exactSessionTarget(sessionName: string): string {
	return `=${sessionName}:`;
}

/**
 * Check if a tmux session exists on the default socket. Used for the outer
 * `pappardelle-{repo}` session. Do not call for per-issue claude/companion
 * sessions — those live on the inner socket; use `innerSessionExists` instead.
 *
 * The name is matched exactly: tmux otherwise falls back to a prefix match,
 * and the default-terminal launcher's viewer sessions share this socket.
 */
export function sessionExists(sessionName: string): boolean {
	try {
		execSync(`tmux has-session -t "${exactSessionTarget(sessionName)}"`, {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a per-issue tmux session exists on the inner socket
 * (`tmux -L pappardelle_inner`).
 */
export function innerSessionExists(sessionName: string): boolean {
	try {
		const result = spawnSync(
			'tmux',
			innerTmuxArgs(['has-session', '-t', exactSessionTarget(sessionName)]),
			{
				encoding: 'utf-8',
				timeout: 5000,
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

export function toSessionKey(issueKey: string): string {
	return issueKey.replaceAll('_', '__').replaceAll('.', '_');
}

export function fromSessionKey(sessionKey: string): string {
	return sessionKey.replaceAll(/__|_/g, match => (match === '__' ? '_' : '.'));
}

/**
 * Get session names for a space.
 * Optional repoName parameter for testing; defaults to getRepoName().
 */
export function getSessionNames(
	issueKey: string,
	repoName?: string,
): {
	agent: string;
	companion: string;
	legacyAgent: string;
} {
	const agentPrefix = getSessionPrefix('agent', repoName);
	const companionPrefix = getSessionPrefix('companion', repoName);
	const key = toSessionKey(issueKey);
	return {
		agent: `${agentPrefix}${key}`,
		companion: `${companionPrefix}${key}`,
		legacyAgent: `${getLegacyAgentSessionPrefix(repoName)}${key}`,
	};
}

/**
 * Argv that runs `command` as a tmux pane's process instead of typing it at a
 * prompt, so it never lands in the user's shell history (pappardelle-2i0).
 *
 * The trailing `:` stops the interactive shell from exec'ing its last command
 * in place, so it hands the terminal back when it exits. Without it, bash 3.2
 * (macOS /bin/sh and /bin/bash) starts the login shell outside the terminal's
 * foreground process group, where it spins at 100% CPU and never reads input.
 */
export function buildShellLaunchArgs(
	command: string,
	reportExit = false,
): string[] {
	const shell = process.env['SHELL'] || '/bin/sh';
	return [
		'/bin/sh',
		'-c',
		reportExit
			? '"$1" -ic "$2$(printf "\\n:")"; printf "\\033]133;A\\007"; exec "$1" -l'
			: '"$1" -ic "$2$(printf "\\n:")"; exec "$1" -l',
		'sh',
		shell,
		command,
	];
}

function paneFrameEntry(): string[] {
	if (isStandalone) return [process.execPath, '--internal-pane-frame'];
	const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
	const entry = fileURLToPath(
		new URL(`pane-frame-cli${extension}`, import.meta.url),
	);
	return [process.execPath, ...bunIsolationArgs, entry];
}

/**
 * The `respawn-pane` command for a viewer pane: the frame host running
 * `command`, then a login shell, inside the pane's frame. Starting it as the
 * pane's process rather than typing it keeps it out of the user's shell
 * history. `-k` kills the previous process, including any nested client
 * attached there. The client tty the previous host published is cleared first
 * so the rail never switches a client that is gone.
 */
function viewerRespawnArgs(
	paneId: string,
	command: string,
	title?: string,
): string[] {
	const host = [
		...paneFrameEntry(),
		...(title === undefined ? [] : ['--title', title]),
		'--',
		'/bin/sh',
		'-c',
		`${command}; exec "$SHELL" -l`,
	];
	return [
		'set-option',
		'-p',
		'-u',
		'-t',
		paneId,
		CLIENT_TTY_OPTION,
		';',
		'respawn-pane',
		'-k',
		'-t',
		paneId,
		host.map(value => shellQuote(value)).join(' '),
	];
}

// Panes whose frame host started with the pane and has no program yet.
const awaitingFrames = new Set<string>();

/**
 * The pane command for a viewer pane created before the rail knows what it
 * will show. The frame host's start-up, the longest part of bringing a viewer
 * up, then overlaps everything between pane setup and the first attachment.
 */
function awaitingFrameCommand(title: string): string {
	return [...paneFrameEntry(), '--title', title, '--await']
		.map(value => shellQuote(value))
		.join(' ');
}

/** `paneId` was created running `awaitingFrameCommand`. Exported for tests. */
export function registerAwaitingFrame(paneId: string): void {
	awaitingFrames.add(paneId);
}

/**
 * Start `command` in a viewer pane's frame. A frame that started with its
 * pane is already waiting for exactly this; any other pane is respawned.
 */
function viewerStartArgs(
	paneId: string,
	command: string,
	title?: string,
): string[] {
	if (!awaitingFrames.delete(paneId))
		return viewerRespawnArgs(paneId, command, title);
	// The frame takes its title from the window title its program sets.
	const titled =
		title === undefined
			? ''
			: `printf '\\033]2;%s\\033\\\\' ${shellQuote(title)}; `;
	return [
		'set-option',
		'-p',
		'-t',
		paneId,
		FRAME_COMMAND_OPTION,
		`${titled}${command}; exec "$SHELL" -l`,
		';',
		'wait-for',
		'-S',
		frameReadyChannel(paneId),
	];
}

function viewerMessageCommand(message: string): string {
	return message ? `clear; printf '%s\\n' ${shellQuote(message)}` : 'clear';
}

// Selecting a space already tries to start its agent and companion, so
// reaching this means the start failed, and the reason was logged to the
// rail's error list.
function viewerNoSessionCommand(
	issueKey: string,
	program: 'agent' | 'companion',
): string {
	const format =
		`\\n  \\033[1m%s\\033[0;2m has no ${program} running\\033[0m\\n\\n` +
		'  \\033[1;7m e \\033[0;2m in the rail shows why\\033[0m\\n\\n';
	return `clear; printf ${shellQuote(format)} ${shellQuote(issueKey)}`;
}

const AGENT_PANE_TITLE = 'agent';
const COMPANION_FRAME_TITLE = 'companion';

function paneTitleArgs(paneId: string, title: string): string[] {
	return ['set-option', '-p', '-t', paneId, PANE_TITLE_OPTION, title];
}

function viewerTitleArgs(
	agentViewerPaneId: string,
	companionViewerPaneId: string,
): string[] {
	const args = paneTitleArgs(agentViewerPaneId, AGENT_PANE_TITLE);
	if (companionViewerPaneId)
		args.push(
			';',
			...paneTitleArgs(companionViewerPaneId, COMPANION_FRAME_TITLE),
		);
	return args;
}

function agentFrameTitle(issueKey: string): string {
	return `agent · ${issueKey}`;
}

function agentTitleAndFocusArgs(
	agentViewerPaneId: string,
	issueKey: string,
	listPaneId?: string,
): string[] {
	const args = paneTitleArgs(agentViewerPaneId, agentFrameTitle(issueKey));
	if (listPaneId) args.push(';', 'select-pane', '-t', listPaneId);
	return args;
}

// The frame host titles a viewer pane's frame with the nested session's window
// title, which tmux sends only while set-titles is on.
// The inner server loads the user's tmux config, and `detach-on-destroy off`
// there would move a viewer's nested client into another space's session when
// the viewed one ends, leaving the pane showing the wrong agent under the
// selected space's title. Detaching instead leaves the pane on `[exited]`.
function viewerSessionArgs(sessionName: string, title: string): string[] {
	const target = exactSessionTarget(sessionName);
	return [
		'set-option',
		'-t',
		target,
		'detach-on-destroy',
		'on',
		';',
		'set-option',
		'-t',
		target,
		'set-titles',
		'on',
		';',
		'set-option',
		'-t',
		target,
		'set-titles-string',
		title.replaceAll('#', '##'),
	];
}

// The frame host's embedded terminal understands modified keys such as
// Shift+Enter, but tmux enables them only for terminals it knows support
// them, and the frame's client identifies as plain xterm-256color. The
// feature is server-scope, and the inner server is Pappardelle's own.
export const FRAME_TERMINAL_FEATURE = 'xterm-256color:extkeys';

// Appended only when the server does not already carry it as a whole entry.
function frameTerminalFeaturesArgs(): string[] {
	return [
		'if-shell',
		'-F',
		`#{m:* ${FRAME_TERMINAL_FEATURE} *, #{terminal-features} }`,
		'',
		`set-option -sa terminal-features ',${FRAME_TERMINAL_FEATURE}'`,
	];
}

// tmux holds a lone Escape typed at a client for `escape-time` in case the
// rest of an escape sequence follows: 10 ms by default, 500 ms before tmux
// 3.5. The frame host writes each key to its client whole, so on the inner
// server the wait only delays Escape on its way to the agent.
const FRAME_ESCAPE_TIME_ARGS = ['set-option', '-s', 'escape-time', '0'];

// Each pane draws its own rounded frame, so tmux's border titles stay off. Set
// on pappardelle's own window only, so the user's other windows keep theirs.
function windowChromeArgs(listPaneId: string): string[] {
	return [
		...windowOptionArgs(listPaneId, 'pane-border-status', 'off'),
		';',
		// Left behind by builds that drew the titles in the border.
		...windowOptionArgs(listPaneId, 'pane-border-format', undefined),
	];
}

// tmux's dividers become a blank gap between frames. A command of its own,
// because tmux drops the rest of a command list at the first error and
// `spaces` only arrived in tmux 3.6. Older releases draw their dividers beside
// the frames unless the lines are concealed.
async function hideDividers(listPaneId: string): Promise<void> {
	try {
		await runTmux(windowOptionArgs(listPaneId, 'pane-border-lines', 'spaces'));
		return;
	} catch (error) {
		log.info(
			`Failed to set pane-border-lines on the layout window: ${String(error)}`,
		);
	}

	try {
		await runTmux([
			...windowOptionArgs(listPaneId, 'pane-border-style', 'hidden'),
			';',
			...windowOptionArgs(listPaneId, 'pane-active-border-style', 'hidden'),
		]);
	} catch (error) {
		log.warn(
			`Failed to hide the layout window's dividers`,
			error instanceof Error ? error : undefined,
		);
	}
}

function windowOptionArgs(
	paneId: string,
	name: string,
	value: string | undefined,
): string[] {
	return value === undefined
		? ['set-option', '-w', '-u', '-t', paneId, name]
		: ['set-option', '-w', '-t', paneId, name, value];
}

/**
 * Build the shell command for starting the agent pane's agent with a
 * resume-then-launch fallback. Tries to resume the space's own conversation
 * (see bindResumeArgs), falling back to a fresh launch if that fails.
 * The ANSI escape clears the "No conversation found" error line on failure.
 *
 * Claude agent profiles (the default when `agentProfile` is omitted) get the
 * claude-specific injections: `--name <issueKey>` on both branches so the
 * session shows up under the issue key in `/resume` and the terminal title,
 * plus the skip-permissions flag. Model/effort flags come from the agent
 * profile's templates, for any CLI that has them. Without `resumeArgs` there
 * is no resume attempt at all (a made-up resume flag would error confusingly
 * on unknown CLIs).
 *
 * The model/effort flags sit before `--name` and the resume args, so a
 * subcommand like codex's `resume` still comes after every flag. Flag order
 * (`--dangerously-skip-permissions`, args, model, effort, `--name`) and the
 * agent composition rule are mirrored by start-agent-session.sh and the
 * open-*-agent.sh launchers; keep them in sync so a session created by the TUI
 * and one created by idow are indistinguishable.
 */
export function buildAgentResumeCommand(
	issueKey: string,
	skipPermissions = false,
	agentProfile: ResolvedAgentProfile = DEFAULT_RESOLVED_AGENT_PROFILE,
	sessionId?: string,
): string {
	let base: string;
	const launchFlags = renderAgentLaunchFlags(agentProfile);
	if (agentProfile.isClaude) {
		const safeKey = quoteLaunchValue(issueKey);
		const withDsp = skipPermissions
			? `${agentProfile.command} --dangerously-skip-permissions`
			: agentProfile.command;
		const withArgs = agentProfile.args
			? `${withDsp} ${agentProfile.args}`
			: withDsp;
		base = `${withArgs}${launchFlags} --name ${safeKey}`;
	} else {
		const withArgs = agentProfile.args
			? `${agentProfile.command} ${agentProfile.args}`
			: agentProfile.command;
		base = `${withArgs}${launchFlags}`;
	}

	const resumeArgs = bindResumeArgs(agentProfile, sessionId);
	if (!resumeArgs) {
		return base;
	}
	return `${base} ${resumeArgs} || { printf '\\033[A\\033[2K'; false; } || ${base}`;
}

const CLIENT_TTY_WAIT_MS = 3000;

const CLIENT_TTY_FORMAT = `#{${CLIENT_TTY_OPTION}}`;

/**
 * The tty of the nested tmux client inside a viewer pane's frame, which the
 * frame's child publishes on the pane as it starts its program.
 */
async function getViewerClientTty(
	paneId: string,
	run: AsyncTmuxRunner,
): Promise<string> {
	const output = await run([
		'display-message',
		'-p',
		'-t',
		paneId,
		CLIENT_TTY_FORMAT,
	]);
	return output.trim();
}

/**
 * The client tty of a frame that was just started, once its child signals
 * that it has published it. A signal left by a start nobody waited for wakes
 * the first wait before the tty is there, so an empty answer waits once more.
 */
async function awaitViewerClientTty(
	paneId: string,
	run: AsyncTmuxRunner,
): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<string>(resolve => {
		timer = setTimeout(resolve, CLIENT_TTY_WAIT_MS, '');
	});
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const started = run([
				'wait-for',
				frameStartedChannel(paneId),
				';',
				'display-message',
				'-p',
				'-t',
				paneId,
				CLIENT_TTY_FORMAT,
			]);
			// Abandoned at the deadline, its own timeout still ends it later.
			started.catch(() => {});
			// eslint-disable-next-line no-await-in-loop -- The second wait depends on the first's answer.
			const output = await Promise.race([started, timedOut]);
			if (output.trim()) return output.trim();
		}

		return '';
	} finally {
		clearTimeout(timer);
	}
}

// What tmux prints when no server is behind the socket. A server exits when
// its last session is killed, and a command that reaches it on its way out
// gets the third.
const SERVER_GONE =
	/^(?:no server running on |error connecting to .* \(No such file or directory\)|server exited unexpectedly)/m;

/**
 * Snapshot the clients available to both viewers.
 * Nested clients created by the viewer-pane attach live on the inner socket,
 * so list-clients must target that socket.
 */
async function innerClientTtys(run: AsyncTmuxRunner): Promise<Set<string>> {
	try {
		const output = await run(
			innerTmuxArgs(['list-clients', '-F', '#{client_tty}']),
		);
		return new Set(output.trim().split('\n'));
	} catch (err) {
		const error = err as NodeJS.ErrnoException & {
			stderr?: string;
			killed?: boolean;
			signal?: string;
		};
		if (
			typeof error.code === 'number' &&
			!error.killed &&
			!error.signal &&
			SERVER_GONE.test(error.stderr ?? '')
		)
			return new Set();
		throw err;
	}
}

/**
 * Switch a tmux client to a different session.
 * The client lives on the inner socket (it was created by our `tmux -L
 * pappardelle_inner attach …`), and switch-client can only move a client
 * between sessions on the *same* socket — which is fine because every
 * per-issue session also lives on the inner socket.
 */
async function switchClientToSession(
	clientTty: string,
	sessionName: string,
	run: AsyncTmuxRunner,
): Promise<void> {
	await run(
		innerTmuxArgs([
			'switch-client',
			'-c',
			clientTty,
			'-t',
			exactSessionTarget(sessionName),
		]),
	);
	log.debug(`Switched client ${clientTty} to session ${sessionName}`);
}

/** The pid tmux started in a pane; it changes when the pane is respawned. */
export async function panePid(paneId: string): Promise<string | undefined> {
	try {
		const pid = await runTmux([
			'display-message',
			'-p',
			'-t',
			paneId,
			'#{pane_pid}',
		]);
		return pid.trim();
	} catch {
		return undefined;
	}
}

/**
 * Kill a tmux session by name on the default socket.
 * Used for the outer `pappardelle-{repo}` session on Pappardelle quit.
 */
export function killSession(sessionName: string): boolean {
	try {
		if (!sessionExists(sessionName)) {
			log.debug(`Session ${sessionName} does not exist, nothing to kill`);
			return true;
		}

		execSync(`tmux kill-session -t "${exactSessionTarget(sessionName)}"`, {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		log.info(`Killed session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to kill session ${sessionName}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Kill a tmux session by name on the inner socket. Used for per-issue
 * claude/companion sessions.
 */
export async function innerKillSession(
	sessionName: string,
	run: AsyncTmuxRunner = runTmux,
): Promise<boolean> {
	try {
		await run(
			innerTmuxArgs(['kill-session', '-t', exactSessionTarget(sessionName)]),
		);
		log.info(`Killed inner session: ${sessionName}`);
		return true;
	} catch (err) {
		const error = err as NodeJS.ErrnoException & {
			stderr?: string;
			signal?: string;
			killed?: boolean;
		};
		// Only tmux's explicit missing-target/server errors mean the session is gone.
		if (
			typeof error.code === 'number' &&
			!error.signal &&
			!error.killed &&
			(SERVER_GONE.test(error.stderr ?? '') ||
				/^(?:can't find session:|no current target)/m.test(error.stderr ?? ''))
		)
			return true;
		log.error(
			`Failed to kill inner session ${sessionName}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Minimal runner surface for `cleanupOrphanedOuterSessions`. Exposed so tests
 * can inject a fake tmux without spawning real processes. The default runner
 * shells out via `spawnSync`.
 */
export type OuterTmuxRunner = (
	args: readonly string[],
	input?: string,
) => {
	error?: Error;
	status: number | null;
	stdout: string;
	stderr?: string;
};

function spawnTmuxRunner(
	toArgv: (args: readonly string[]) => string[],
	env?: () => NodeJS.ProcessEnv,
): OuterTmuxRunner {
	return (args, input) => {
		const r = spawnSync('tmux', toArgv(args), {
			cwd: TMUX_SERVER_CWD,
			encoding: 'utf-8',
			input,
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: env?.(),
		});
		return {
			error: r.error,
			status: r.status,
			stdout: r.stdout ?? '',
			stderr: r.stderr ?? '',
		};
	};
}

export const defaultOuterTmuxRunner = spawnTmuxRunner(args => [...args]);

// Outer TUI sessions are named `pappardelle-<repo>`.
export const OUTER_SESSION_PREFIX = 'pappardelle-';

export function outerSessionName(repoName: string): string {
	return `${OUTER_SESSION_PREFIX}${repoName}`;
}

// Bare tmux talks to whichever server $TMUX names. From a claude pane that is
// the inner `pappardelle_inner` server, which holds no TUI sessions, so calls
// that must reach the default server drop TMUX (TMUX_TMPDIR still applies).
export function defaultServerTmuxEnv(
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const {TMUX: _tmux, TMUX_PANE: _pane, ...rest} = env;
	return rest;
}

export const defaultServerTmuxRunner = spawnTmuxRunner(
	args => [...args],
	() => defaultServerTmuxEnv(process.env),
);

function envSocketIs(env: NodeJS.ProcessEnv, socketName: string): boolean {
	const socket = env['TMUX']?.split(',')[0];
	if (!socket) return false;
	const uid = process.getuid?.() ?? 0;
	const selectedPath = socketName.startsWith('/')
		? socketName
		: join(env['TMUX_TMPDIR'] || '/tmp', `tmux-${uid}`, socketName);
	return sameFile(socket, selectedPath);
}

// True inside a claude/companion pane. Killing the inner server from there
// ends this process.
export function isOnInnerServer(env: NodeJS.ProcessEnv): boolean {
	return envSocketIs(env, statusSocket(env));
}

// The default-server session this process runs in, or null when it runs
// outside tmux or on another server (an inner claude pane, where killing an
// outer session only detaches the client and leaves this process alive).
export function currentDefaultServerSession(
	env: NodeJS.ProcessEnv,
	runner: OuterTmuxRunner = defaultServerTmuxRunner,
): string | null {
	return currentSession(env, 'default', runner);
}

// The inner-server session this process runs in: a space's claude or
// companion session, which ends this process when it is killed.
export function currentInnerServerSession(
	env: NodeJS.ProcessEnv,
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
): string | null {
	return currentSession(env, statusSocket(env), runner);
}

function currentSession(
	env: NodeJS.ProcessEnv,
	socketName: string,
	runner: OuterTmuxRunner,
): string | null {
	const pane = env['TMUX_PANE'];
	if (!pane || !envSocketIs(env, socketName)) return null;

	const result = runner([
		'display-message',
		'-p',
		'-t',
		pane,
		'#{session_name}',
	]);
	if (result.error || result.status !== 0) return null;
	return result.stdout.trim() || null;
}

/**
 * Kill any leftover `agent-{repo}-*` / `claude-{repo}-*` and
 * `companion-{repo}-*` sessions still living on the default tmux socket from
 * a pre-STA-860 Pappardelle run. They can't be migrated (tmux doesn't move
 * sessions between servers), so we drop them and let idow/Pappardelle
 * recreate them on the inner socket.
 *
 * Intentionally targets the default socket (no `-L pappardelle_inner`) and
 * uses bare `kill-session` — this is the one inner-session-name operation
 * that must not route through `innerKillSession`. See STA-860.
 *
 * Returns the number of sessions killed.
 *
 * `runner` is exposed for tests only; production always uses the spawnSync
 * default.
 */
export function cleanupOrphanedOuterSessions(
	repoName?: string,
	runner: OuterTmuxRunner = defaultOuterTmuxRunner,
): number {
	try {
		const agentPrefix = getSessionPrefix('agent', repoName);
		const legacyAgentPrefix = getLegacyAgentSessionPrefix(repoName);
		const companionPrefix = getSessionPrefix('companion', repoName);
		// Pre-STA-1464 the companion pane was named `lazygit-{repo}-*`. Sweep that
		// legacy prefix too so an upgrade doesn't strand old git-UI sessions.
		const repo = repoName ?? getRepoName();
		const legacyCompanionPrefix = `lazygit-${tmuxSessionRepo(repo)}-`;

		const result = runner(['list-sessions', '-F', '#{session_name}']);
		if (result.error || result.status !== 0) {
			return 0;
		}

		const orphans = result.stdout
			.trim()
			.split('\n')
			.filter(
				name =>
					name.startsWith(agentPrefix) ||
					name.startsWith(legacyAgentPrefix) ||
					name.startsWith(companionPrefix) ||
					name.startsWith(legacyCompanionPrefix),
			);

		let killed = 0;
		for (const name of orphans) {
			const k = runner(['kill-session', '-t', exactSessionTarget(name)]);
			if (!k.error && k.status === 0) {
				killed++;
				log.info(`Killed orphaned outer-socket session: ${name}`);
			}
		}
		return killed;
	} catch {
		return 0;
	}
}

/**
 * Inner-socket runner: routes through `innerTmuxArgs` so calls hit
 * `tmux -L pappardelle_inner`. Same shape as `OuterTmuxRunner` so
 * `cleanupOrphanedInnerSessions` can share the injectable-runner test
 * harness without duplicating the fake-runner plumbing.
 */
export const defaultInnerTmuxRunner = spawnTmuxRunner(innerTmuxArgs);

/**
 * DEC 2026 "synchronized output": the terminal buffers everything between
 * `ESC [ ? 2026 h` and `ESC [ ? 2026 l` and presents it as one frame.
 */
export const SYNC_TERMINAL_FEATURE = '*:Sync';

/**
 * Make tmux batch each repaint into a single atomic frame.
 *
 * tmux only wraps a redraw in DEC 2026 when it believes the attached client's
 * terminal supports Sync, and it decides that from the client's TERM. Our panes
 * routinely run clients whose TERM is `tmux-256color`, which advertises no
 * Sync. That is the normal shape here: the claude and companion panes each host
 * a nested `tmux -L pappardelle_inner attach`, so the client is attached from
 * inside another tmux. tmux then streams every repaint out unbatched,
 * so the outer terminal can present a half-drawn frame. That is the flicker seen
 * while typing, worst when the zoomed list pane repaints full-screen per
 * keystroke.
 *
 * `terminal-features` is server-scope; tmux offers no session or window scope
 * for it, so on the outer socket this necessarily touches the whole tmux server.
 * Two things keep that safe: we append (`-ga`) instead of assigning, so any
 * user-configured features survive, and terminals that don't implement DEC 2026
 * ignore the private mode, which is what makes the blanket `*` workable.
 *
 * The append is conditional on the socket not already carrying the entry:
 * `-ga` alone adds another copy on every launch against a long-lived server.
 */
export function synchronizedOutputArgs(): string[] {
	const entry = SYNC_TERMINAL_FEATURE.replace('*', String.raw`\*`);
	return [
		'if-shell',
		'-F',
		`#{m:* ${entry} *, #{terminal-features} }`,
		'',
		`set-option -ga terminal-features ',${SYNC_TERMINAL_FEATURE}'`,
	];
}

/**
 * The inner socket is a separate tmux server with its own option table.
 * `run` is exposed for tests only.
 */
export async function enableInnerSynchronizedOutput(
	run: AsyncTmuxRunner = runTmux,
): Promise<void> {
	try {
		await run(innerTmuxArgs(synchronizedOutputArgs()));
	} catch {
		// Purely a rendering nicety — never let it break layout setup.
		log.debug('Could not enable synchronized output on inner socket');
	}
}

/**
 * Pane frames dim when their pane loses focus, and they learn that from the
 * focus reports tmux sends only while `focus-events` is on. The option is
 * server-scope, like `terminal-features` above; it only adds reports for
 * programs that ask for them.
 */
const FOCUS_EVENTS_ARGS = ['set-option', '-g', 'focus-events', 'on'];

/**
 * STA-1420 layer 2: reap orphaned `agent-{repo}-*` / `companion-{repo}-*`
 * (and legacy `claude-{repo}-*` / `lazygit-{repo}-*`) sessions on the inner socket whose key is
 * neither in the registry nor the
 * main worktree (`'main'`). Symmetric to `cleanupOrphanedOuterSessions` but
 * for inner-socket leftovers — these accumulate when Pappardelle is hard-quit
 * (SIGKILL, terminal close, Ctrl-C during a slow `pre_workspace_deinit`)
 * between unregistering and killing. STA-1416 removed the `seedFromTmux`
 * resurrection helper that used to mop these up as a side effect, so without
 * this reaper they'd linger forever on the inner socket.
 *
 * Conservative on purpose: only kills sessions whose key is missing from the
 * registry AND isn't `MAIN_WORKTREE_KEY`. The main worktree row in app.tsx
 * uses the same constant, so its sessions (`agent-{repo}-main`,
 * `companion-{repo}-main`) are legitimate but never appear in the registry —
 * the constant keeps the "never reap main" coupling explicit on both sides.
 *
 * `runner` is exposed for tests only; production uses the spawnSync default.
 */
export function cleanupOrphanedInnerSessions(
	registeredKeys: Set<string>,
	repoName?: string,
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
	knownRepos: string[] = listKnownRepos(),
): number {
	try {
		const agentPrefix = getSessionPrefix('agent', repoName);
		const legacyAgentPrefix = getLegacyAgentSessionPrefix(repoName);
		const companionPrefix = getSessionPrefix('companion', repoName);
		// Pre-STA-1464 the companion pane was named `lazygit-{repo}-*`. Reap that
		// legacy prefix too so a hard-quit straddling an upgrade doesn't strand old
		// git-UI sessions on the inner socket. Mirrors cleanupOrphanedOuterSessions.
		const repo = repoName ?? getRepoName();
		const legacyCompanionPrefix = `lazygit-${tmuxSessionRepo(repo)}-`;

		const longerRepoPrefixes = siblingRepoPrefixes(repo, knownRepos);

		const result = runner(['list-sessions', '-F', '#{session_name}']);
		if (result.error || result.status !== 0) {
			return 0;
		}

		const orphans: Array<{name: string; key: string}> = [];
		for (const name of result.stdout.trim().split('\n')) {
			if (longerRepoPrefixes.some(prefix => name.startsWith(prefix))) continue;
			let key: string | null = null;
			if (name.startsWith(agentPrefix)) {
				key = fromSessionKey(name.slice(agentPrefix.length));
			} else if (name.startsWith(legacyAgentPrefix)) {
				key = fromSessionKey(name.slice(legacyAgentPrefix.length));
			} else if (name.startsWith(companionPrefix)) {
				key = fromSessionKey(name.slice(companionPrefix.length));
			} else if (name.startsWith(legacyCompanionPrefix)) {
				key = fromSessionKey(name.slice(legacyCompanionPrefix.length));
			} else {
				continue;
			}
			if (key === MAIN_WORKTREE_KEY) continue;
			if (registeredKeys.has(key)) continue;
			orphans.push({name, key});
		}

		let killed = 0;
		const failedKeys = new Set<string>();
		for (const {name, key} of orphans) {
			const k = runner(['kill-session', '-t', exactSessionTarget(name)]);
			if (!k.error && k.status === 0) {
				killed++;
				log.info(`Killed orphaned inner-socket session: ${name}`);
			} else {
				failedKeys.add(key);
			}
		}
		for (const key of new Set(orphans.map(orphan => orphan.key)))
			if (!failedKeys.has(key)) removeProgramSnapshots(repo, key);
		return killed;
	} catch {
		return 0;
	}
}

const simulatorCleanup = new QaSimulatorCleanup(
	undefined,
	key => !isSpaceRegistered(key),
);

export async function deleteQaSimulator(issueKey: string): Promise<boolean> {
	return simulatorCleanup.delete(issueKey);
}

/** Kill both inner sessions without changing the workspace registry. */
export async function killSpaceSessions(
	issueKey: string,
	options?: {
		run?: AsyncTmuxRunner;
		repoName?: string;
	},
): Promise<boolean> {
	const sessions = getSessionNames(issueKey, options?.repoName);
	// Keep the agent running until companion teardown succeeds. Reattaching
	// after a companion failure must not recreate Claude with --continue.
	if (!(await innerKillSession(sessions.companion, options?.run))) return false;
	const killed = await innerKillSession(sessions.agent, options?.run);
	// Also address the legacy name: a space whose session hasn't been
	// migrated yet would otherwise survive its own teardown (innerKillSession
	// returns true for missing sessions, so the agent-name kill "succeeds").
	const legacyKilled = await innerKillSession(
		sessions.legacyAgent,
		options?.run,
	);
	if (currentlyViewingSpace === issueKey) {
		currentlyViewingSpace = null;
		agentViewerHasClient = false;
		companionViewerHasClient = false;
	}
	return killed && legacyKilled;
}

/**
 * Rename one legacy `claude-*` session to its `agent-*` name. `rename-session`
 * leaves panes and running processes untouched, so an in-flight conversation
 * survives.
 */
function renameLegacySession(
	legacyName: string,
	target: string,
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
): boolean {
	const r = runner(legacyRenameArgs(legacyName, target));
	if (r.error || r.status !== 0) {
		return false;
	}
	log.info(`Migrated legacy session ${legacyName} → ${target}`);
	return true;
}

function legacyRenameArgs(legacyName: string, target: string): string[] {
	return ['rename-session', '-t', exactSessionTarget(legacyName), target];
}

/**
 * The inner socket is shared by every repo, and `agent-proj-` also prefixes
 * the sessions of a repo named proj-x.
 */
function siblingRepoPrefixes(repo: string, knownRepos: string[]): string[] {
	const own = `${tmuxSessionRepo(repo)}-`;
	return knownRepos
		.map(other => tmuxSessionRepo(other))
		.filter(other => other.startsWith(own))
		.flatMap(other =>
			['agent', 'claude', 'companion', 'lazygit'].map(
				kind => `${kind}-${other}-`,
			),
		);
}

export async function focusPane(
	paneId: string,
	run: AsyncTmuxRunner = runTmux,
): Promise<void> {
	try {
		await run(['select-pane', '-t', paneId]);
	} catch (error) {
		log.warn(`Failed to focus pane ${paneId}`, error as Error);
	}
}

/**
 * An inner-socket runner for the startup maintenance passes, which each begin
 * by listing the sessions. The listing is reused until a pass renames or kills
 * a session.
 */
export function sharedSessionListingRunner(
	run: OuterTmuxRunner = defaultInnerTmuxRunner,
): OuterTmuxRunner {
	let listing: ReturnType<OuterTmuxRunner> | undefined;
	return (args, input) => {
		if (args[0] !== 'list-sessions') {
			listing = undefined;
			return run(args, input);
		}

		listing ??= run(args, input);
		return listing;
	};
}

/**
 * Rename live legacy `claude-{repo}-{key}` sessions on the inner socket to
 * their `agent-{repo}-{key}` names. cli.tsx runs it when the TUI starts,
 * before the orphan reap, and before `pappardelle send`, which can run before
 * the TUI restarts. start-agent-session.sh does the same for the one space
 * idow opens.
 *
 * A legacy session whose `agent-` name is already taken (an old and a new
 * build both launched the space during the upgrade) is killed: pappardelle
 * only ever attaches the `agent-` session, and the orphan reaper keeps both
 * for a registered key, so the legacy process would otherwise run unseen
 * forever.
 *
 * Returns the number of sessions renamed. `runner` is exposed for tests only.
 */
export function migrateLegacyAgentSessions(
	repoName?: string,
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
	knownRepos: string[] = listKnownRepos(),
): number {
	try {
		const agentPrefix = getSessionPrefix('agent', repoName);
		const legacyPrefix = getLegacyAgentSessionPrefix(repoName);
		const siblingPrefixes = siblingRepoPrefixes(
			repoName ?? getRepoName(),
			knownRepos,
		);

		const result = runner(['list-sessions', '-F', '#{session_name}']);
		if (result.error || result.status !== 0) {
			return 0;
		}

		const sessions = result.stdout.trim().split('\n');
		const existing = new Set(sessions);
		let renamed = 0;
		for (const name of sessions) {
			if (!name.startsWith(legacyPrefix)) continue;
			if (siblingPrefixes.some(prefix => name.startsWith(prefix))) continue;
			const target = `${agentPrefix}${name.slice(legacyPrefix.length)}`;
			if (existing.has(target)) {
				runner(['kill-session', '-t', exactSessionTarget(name)]);
				log.warn(
					`Killed legacy session ${name}: ${target} already exists and is the one pappardelle attaches`,
				);
				continue;
			}
			if (renameLegacySession(name, target, runner)) {
				renamed++;
			}
		}
		return renamed;
	} catch {
		return 0;
	}
}

type TmuxResult = ReturnType<OuterTmuxRunner>;

/** Same shape as `OuterTmuxRunner`, without blocking the TUI's input and rendering. */
export type SendTmuxRunner = (
	args: readonly string[],
	input?: string,
) => TmuxResult | Promise<TmuxResult>;

function spawnTmuxRunnerAsync(
	toArgv: (args: readonly string[]) => string[],
): SendTmuxRunner {
	return async (args, input) =>
		new Promise(resolve => {
			let stdout = '';
			let stderr = '';
			const child = spawn('tmux', toArgv(args), {
				cwd: TMUX_SERVER_CWD,
				stdio: ['pipe', 'pipe', 'pipe'],
				timeout: 5000,
			});
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
				stderr += chunk;
			});
			child.on('error', error => {
				resolve({error, status: null, stdout, stderr});
			});
			child.on('close', status => {
				resolve({status, stdout, stderr});
			});
			// tmux exiting early (a bad target) closes stdin under a large paste.
			child.stdin.on('error', () => {});
			child.stdin.end(input);
		});
}

const defaultInnerSendRunner = spawnTmuxRunnerAsync(innerTmuxArgs);

// Claude Code, Codex and agy have no key that empties the whole composer, and
// C-u alone clears only from the cursor to the start of its line, so a draft
// left behind (say after an agent rejected a command) was submitted with the
// prompt. Each round empties one line wherever the cursor is: C-e and C-k pull
// the next line up, C-u clears it, and BSpace joins it to the line above. A
// round on an empty composer does nothing. Rounds bound the draft that can be
// cleared; 200 lines send in a few milliseconds, and Claude Code collapses a
// longer paste into one placeholder that a single round removes.
export const CLEAR_COMPOSER_ROUNDS = 200;
const CLEAR_COMPOSER_KEYS = Array.from({length: CLEAR_COMPOSER_ROUNDS}, () => [
	'C-e',
	'C-k',
	'C-u',
	'BSpace',
]).flat();

/**
 * Leave any pane mode, empty the composer, paste `text`, then press Enter.
 *
 * Agents detect a fast burst of keystrokes as a paste and turn an Enter that
 * arrives inside it into a newline: Codex does this even when Enter is its own
 * `send-keys` call, and drops the newlines of text typed key by key. A
 * bracketed paste marks where the text ends, so the Enter after it submits.
 * `-r` keeps newlines as LF, so an app without bracketed paste mode does not
 * receive each line as a separate submit.
 *
 * A viewer pane scrolled back in copy-mode would swallow the Enter while the
 * paste still reaches the agent. The text goes through stdin because tmux
 * rejects a command line over ~16KB.
 *
 * Stops at the first failing call so Enter is never sent without the text.
 * `-d` only deletes the buffer when the paste succeeds, so a failed paste
 * deletes it explicitly rather than leave the prompt on the server.
 */
export async function pasteThenEnter(
	runner: SendTmuxRunner,
	target: string,
	text: string,
): Promise<boolean> {
	const buffer = `pappardelle-send-${process.pid}`;
	const steps: Array<{args: string[]; input?: string}> = [
		{args: ['copy-mode', '-q', '-t', target]},
		{args: ['send-keys', '-t', target, ...CLEAR_COMPOSER_KEYS]},
		{args: ['load-buffer', '-b', buffer, '-'], input: text},
		{args: ['paste-buffer', '-p', '-d', '-r', '-b', buffer, '-t', target]},
		{args: ['send-keys', '-t', target, 'Enter']},
	];
	for (const {args, input} of steps) {
		const r = await runner(args, input);
		if (r.error || r.status !== 0) {
			if (args[0] === 'paste-buffer')
				await runner(['delete-buffer', '-b', buffer]);
			return false;
		}
	}

	return true;
}

/**
 * Resolve a per-issue session name to a `send-keys` target on the inner socket.
 * `=` forces an exact match, so `STA-1` never falls through to `STA-12` by prefix.
 */
export async function resolveInnerSessionTarget(
	sessionName: string,
	runner: SendTmuxRunner = defaultInnerSendRunner,
): Promise<string | null> {
	const result = await runner(['list-sessions', '-F', '#{session_name}']);
	if (result.error || result.status !== 0) return null;
	const live = result.stdout.trim().split('\n');
	return live.includes(sessionName) ? exactSessionTarget(sessionName) : null;
}

export type SendToSpaceAgentResult = 'sent' | 'no-session' | 'busy' | 'failed';

/**
 * Submit `text` as a prompt to the agent session of a space.
 * Backs `pappardelle send`, which the sous-chef skill relays through.
 */
export async function sendToSpaceAgent(
	issueKey: string,
	text: string,
	options: {
		repoName?: string;
		runner?: SendTmuxRunner;
		lockDir?: string;
		lockTimeoutMs?: number;
	} = {},
): Promise<SendToSpaceAgentResult> {
	const runner = options.runner ?? defaultInnerSendRunner;
	const session = getSessionNames(issueKey, options.repoName).agent;
	const target = await resolveInnerSessionTarget(session, runner);
	if (!target) return 'no-session';
	try {
		return await withSendLock(
			session,
			async () =>
				(await pasteThenEnter(runner, target, text)) ? 'sent' : 'failed',
			{dir: options.lockDir, timeoutMs: options.lockTimeoutMs},
		);
	} catch (error) {
		if (error instanceof SendLockTimeout) return 'busy';
		log.error(`Send to ${session} failed`, error as Error);
		return 'failed';
	}
}

/**
 * Detach from any tmux session running in a pane
 * This sends the detach command (prefix + d) to the nested tmux
 */
// ============================================================================
// Tmux Dimension Helpers
// ============================================================================

/**
 * Build the `tmux display-message` argv for reading a pane format variable.
 */
export function paneQueryArgs(format: string, paneId?: string): string[] {
	const args = ['display-message', '-p'];
	if (paneId) args.push('-t', paneId);
	args.push(format);
	return args;
}

async function runLayoutCommand(args: string[], run: AsyncTmuxRunner) {
	try {
		return {stdout: await run(args), stderr: '', status: 0, error: undefined};
	} catch (error) {
		return {stdout: '', stderr: String(error), status: 1, error};
	}
}

async function recordPaneSampleAsync(
	listPaneId: string,
	companionViewerPaneId: string,
	run: AsyncTmuxRunner,
): Promise<WindowGeometry> {
	const geometry = parseWindowGeometry(await run(paneGeometryArgs(listPaneId)));
	recordGeometry(geometry, listPaneId, companionViewerPaneId);
	return geometry;
}

// tmux rounds split sizes; sample the resulting window and side panes together
// so rounding or a concurrent window resize cannot masquerade as a hand-drag.
function recordGeometry(
	snapshot: WindowGeometry,
	listPaneId: string,
	companionPaneId: string,
): void {
	lastWindowSize = snapshot.window;
	lastRailWidth = paneGeometry(snapshot, listPaneId).cols;
	// The companion pane closes when the shell left in it exits.
	lastCompanionWidth = snapshot.panes.get(companionPaneId)?.cols ?? null;
}

function readGeometrySync(paneId: string): WindowGeometry | null {
	const result = spawnSync('tmux', paneGeometryArgs(paneId), {
		encoding: 'utf-8',
		timeout: 5000,
	});
	if (result.error || result.status !== 0) return null;
	try {
		return parseWindowGeometry(result.stdout);
	} catch {
		return null;
	}
}

/**
 * Get the number of active spaces from the persisted registry.
 * Uses the space registry (JSON file) as the single source of truth,
 * rather than querying tmux sessions directly. This ensures correct
 * counts even when pappardelle starts after a tmux server kill/reboot.
 */
export function getActiveSpaceCount(): number {
	return getRegisteredSpaces().length;
}

// ============================================================================
// Internal Wrapper Functions (use persisted space registry for counts)
// ============================================================================

/**
 * Number of items the list pane renders in addition to each registered space:
 * the always-pinned main-worktree row that app.tsx prepends to the list. Layout
 * sizing must include this row or the bottom of the list gets clipped on
 * narrow screens.
 */
const PINNED_LIST_ROWS = 1;

/**
 * Calculate the ideal list pane height based on current space count.
 * Reads from the persisted space registry and adds the pinned main-worktree row.
 */
export function calculateIdealListHeight(): number {
	return calculateIdealListHeightForCount(
		getActiveSpaceCount() + PINNED_LIST_ROWS,
		getConfiguredListLines(),
	);
}

/**
 * Calculate pane layout based on terminal dimensions.
 * Reads space count from the persisted registry and adds the pinned
 * main-worktree row to the visible item count.
 */
export function calculateLayout(
	totalWidth: number,
	totalHeight: number,
): LayoutConfig {
	return calculateLayoutForSize(
		totalWidth,
		totalHeight,
		getActiveSpaceCount() + PINNED_LIST_ROWS,
		currentPaneWidths(),
		getConfiguredListLines(),
	);
}

/**
 * A dragged width replaces the configured one for that pane. Once either side
 * has been dragged, claude takes whatever is left, the same as under the mouse.
 */
function currentPaneWidths(): PaneWidths {
	const configured = getConfiguredPaneWidths();
	const dragged = railWidthOverride !== null || companionWidthOverride !== null;
	return {
		rail: railWidthOverride ?? configured.rail,
		companion: companionWidthOverride ?? configured.companion,
		claude: dragged ? null : configured.claude,
	};
}

/**
 * Set up the pane layout for pappardelle
 * Returns pane IDs for [list, agentViewer, companionViewer]
 *
 * Layout depends on screen width:
 * - Narrow screens (< 100 chars): Vertical layout [list on top] [agent below], no companion
 * - Wide screens (>= 100 chars): Horizontal layout [list] [claude] [companion]
 *
 * Asynchronous so the caller can load the renderer while tmux works.
 */
export async function setupPappardellLayout(): Promise<PaneLayout | null> {
	const done = startupTrace.current?.begin('layout-setup');
	try {
		// Get current pane from TMUX_PANE env var
		const listPaneId = process.env['TMUX_PANE'];
		if (!listPaneId) {
			log.error('TMUX_PANE environment variable not set');
			done?.('failed');
			return null;
		}

		const cwd = process.cwd();

		// Before the splits the rail's own terminal is the whole pane.
		const {columns, rows} = process.stdout;
		const initial =
			columns && rows
				? {cols: columns, rows}
				: readGeometrySync(listPaneId)?.panes.get(listPaneId);
		const totalWidth = initial?.cols ?? 120;
		const totalHeight = initial?.rows ?? 40;
		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Terminal size: ${totalWidth}x${totalHeight}, layout: ${layout.direction}`,
		);

		// A split makes its new pane the target of an untargeted command that
		// follows it in the same list, which is how each pane gets its title
		// before its id is known.
		const split = (
			direction: '-h' | '-v',
			size: number | undefined,
			title: string,
		) => [
			'split-window',
			direction,
			'-t',
			listPaneId,
			'-c',
			cwd,
			'-l',
			String(size),
			'-P',
			'-F',
			'#{pane_id}',
			awaitingFrameCommand(title),
			';',
			'set-option',
			'-p',
			PANE_TITLE_OPTION,
			title,
		];
		const hasCompanion =
			layout.direction !== 'vertical' &&
			(layout.companionWidth ?? 0) >= MIN_COMPANION_WIDTH;
		const agentWidth = layout.agentWidth ?? 40;
		let splits: string[];
		if (layout.direction === 'vertical') {
			// List on top, agent below, no companion.
			splits = split('-v', layout.agentHeight, AGENT_PANE_TITLE);
		} else if (hasCompanion) {
			// Both splits take their columns from the list pane, so the rightmost
			// pane is made first and neither needs the other's id.
			splits = [
				...split('-h', layout.companionWidth, COMPANION_FRAME_TITLE),
				';',
				...split('-h', agentWidth, AGENT_PANE_TITLE),
			];
		} else {
			log.info(
				`Not enough space for companion pane (need ${MIN_COMPANION_WIDTH}, have ${layout.companionWidth})`,
			);
			splits = split(
				'-h',
				agentWidth + (layout.companionWidth ?? 0) + 1,
				AGENT_PANE_TITLE,
			);
		}

		// Ordered so the measurements are taken before the two server options,
		// the likeliest to be refused.
		const windowSetup = [
			...paneTitleArgs(listPaneId, RAIL_PANE_TITLE),
			';',
			...windowChromeArgs(listPaneId),
			';',
			'select-pane',
			'-t',
			listPaneId,
			';',
			...paneGeometryArgs(listPaneId),
			';',
			...FOCUS_EVENTS_ARGS,
			';',
			...synchronizedOutputArgs(),
		];

		const panesDone = startupTrace.current?.begin('setup-panes');
		const [created] = await Promise.all([
			runSetup([...splits, ';', ...windowSetup]),
			hideDividers(listPaneId),
			enableInnerSynchronizedOutput(),
		]);
		const lines = created.stdout.trim().split('\n');
		const paneIds = lines.filter(line => /^%\d+$/.test(line));
		// tmux stops at the first split that fails, so a single id from two
		// splits is the pane that was to be the companion. It hosts the agent.
		const agentViewerPaneId = paneIds.at(-1);
		const companionViewerPaneId =
			hasCompanion && paneIds.length === 2 ? paneIds[0]! : '';
		if (!agentViewerPaneId) {
			log.error(`Failed to create agent viewer pane: ${created.stderr}`);
			panesDone?.('failed');
			done?.('failed');
			return null;
		}

		for (const paneId of paneIds) registerAwaitingFrame(paneId);
		let geometry = lines.filter(line => !paneIds.includes(line)).join('\n');
		if (!created.ok) {
			// The list stopped part-way, so the window is set up on its own.
			log.error(`Failed to create a viewer pane: ${created.stderr}`);
			const retried = await runSetup(windowSetup);
			geometry = retried.stdout;
			if (!retried.ok)
				log.warn(
					`Failed to finish setting up the layout window: ${retried.stderr}`,
				);
		}

		panesDone?.();
		log.info(
			layout.direction === 'vertical'
				? `Vertical layout: list=${layout.listHeight} rows, agent=${layout.agentHeight} rows`
				: `Horizontal layout: list=${layout.listWidth}, agent=${layout.agentWidth}, companion=${layout.companionWidth}`,
		);
		log.info(
			`Set up pappardelle layout: list=${listPaneId}, agent=${agentViewerPaneId}, companion=${
				companionViewerPaneId || '(none)'
			}`,
		);

		try {
			recordGeometry(
				parseWindowGeometry(geometry),
				listPaneId,
				companionViewerPaneId,
			);
		} catch {
			lastWindowSize = null;
			lastRailWidth = null;
			lastCompanionWidth = null;
		}

		done?.();
		void closeOrphanedViewerPanes(listPaneId, paneIds);

		return {listPaneId, agentViewerPaneId, companionViewerPaneId};
	} catch (err) {
		log.error(
			'Failed to set up pappardelle layout',
			err instanceof Error ? err : undefined,
		);
		done?.('failed');
		return null;
	}
}

const RAIL_PANE_TITLE = 'rail';

/**
 * The viewer panes a rail left behind when it was killed or crashed: frame
 * hosts in this rail's window that it did not create, and frame hosts in a
 * window of the session that no rail runs in. `listing` is one line per pane
 * of the session: window id, pane id, pane title option and start command,
 * tab-separated. Exported for tests.
 */
export function orphanedViewerPanes(
	listing: string,
	listPaneId: string,
	viewerPaneIds: readonly string[],
): string[] {
	const panes = listing
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [windowId, paneId, title, ...command] = line.split('\t');
			return {windowId, paneId: paneId!, title, command: command.join('\t')};
		});
	const ownWindow = panes.find(pane => pane.paneId === listPaneId)?.windowId;
	const railWindows = new Set(
		panes
			.filter(pane => pane.title === RAIL_PANE_TITLE)
			.map(pane => pane.windowId),
	);
	return panes
		.filter(
			pane =>
				/--internal-pane-frame|pane-frame-cli/.test(pane.command) &&
				!viewerPaneIds.includes(pane.paneId) &&
				(pane.windowId === ownWindow || !railWindows.has(pane.windowId)),
		)
		.map(pane => pane.paneId);
}

async function closeOrphanedViewerPanes(
	listPaneId: string,
	viewerPaneIds: readonly string[],
): Promise<void> {
	const listed = await runSetup([
		'list-panes',
		'-s',
		'-t',
		listPaneId,
		'-F',
		`#{window_id}\t#{pane_id}\t#{${PANE_TITLE_OPTION}}\t#{pane_start_command}`,
	]);
	if (!listed.ok) return;
	const orphans = orphanedViewerPanes(listed.stdout, listPaneId, viewerPaneIds);
	if (orphans.length === 0) return;
	log.info(
		`Closing viewer panes left by an earlier rail: ${orphans.join(' ')}`,
	);
	await runSetup(
		orphans.flatMap((paneId, index) => [
			...(index === 0 ? [] : [';']),
			'kill-pane',
			'-t',
			paneId,
		]),
	);
}

// A command list that stops part-way has still printed what its earlier
// commands had to say, which the caller needs.
async function runSetup(
	args: string[],
): Promise<{ok: boolean; stdout: string; stderr: string}> {
	try {
		const {stdout, stderr} = await execFileAsync('tmux', args, {
			cwd: TMUX_SERVER_CWD,
			encoding: 'utf-8',
			timeout: 10_000,
		});
		return {ok: true, stdout, stderr};
	} catch (error) {
		const failed = error as {stdout?: string; stderr?: string};
		return {
			ok: false,
			stdout: failed.stdout ?? '',
			stderr: failed.stderr ?? String(error),
		};
	}
}

function isMissingSessionError(err: unknown): boolean {
	const error = err as NodeJS.ErrnoException & {
		stderr?: string;
		signal?: string;
		killed?: boolean;
	};
	return (
		typeof error.code === 'number' &&
		!error.signal &&
		!error.killed &&
		/^can't find (?:session|client):/m.test(error.stderr ?? '')
	);
}

/** The profile a space was created with; the main space has none. */
function savedSpaceProfile(issueKey: string): string | undefined {
	return issueKey === MAIN_WORKTREE_KEY
		? undefined
		: readSpaceState(getRepoName(), issueKey)?.profile;
}

/**
 * The agent profile running in a space: the one whose agent started last,
 * which covers a one-launch picker override, else the one its profile
 * selects. A recorded name the config no longer defines falls back too.
 */
export function runningAgentProfile(
	config: PappardelleConfig,
	issueKey: string,
	issueTitle?: string,
): ResolvedAgentProfile {
	const profileName = savedSpaceProfile(issueKey);
	const latest = latestAgentProfile(getRepoName(), issueKey);
	const name =
		latest && (latest === 'claude' || config.agent_profiles?.[latest])
			? latest
			: resolveAgentProfileName(config, issueTitle, profileName);
	return getNamedAgentProfile(config, name, issueTitle, profileName);
}

/**
 * Attach viewer panes to a space's sessions
 *
 * Uses tmux switch-client for instant, invisible session switching when a nested
 * client already exists in the viewer pane. Falls back to respawning the pane
 * with an attach command for the initial attachment.
 */
export async function attachToSpace(
	agentViewerPaneId: string,
	companionViewerPaneId: string,
	...rest: [
		issueKey: string,
		listPaneId?: string,
		mainWorktreePath?: string,
		issueTitle?: string,
		options?: {signal?: AbortSignal; run?: AsyncTmuxRunner},
	]
): Promise<boolean> {
	return attachViewers(
		agentViewerPaneId,
		closedCompanionPanes.has(companionViewerPaneId)
			? ''
			: companionViewerPaneId,
		...rest,
	);
}

// What tmux says of a pane that no longer exists; the wording depends on the
// command.
const PANE_GONE = /^(?:can't find pane|no such pane):/m;

// Companion viewer panes that have closed: the shell left in one after its
// program ends can be exited. The layout still names the pane until it is
// rebuilt, and a workspace then has only its agent to show.
const closedCompanionPanes = new Set<string>();

async function attachViewers(
	agentViewerPaneId: string,
	companionViewerPaneId: string,
	issueKey: string,
	listPaneId?: string,
	mainWorktreePath?: string,
	issueTitle?: string,
	options: {signal?: AbortSignal; run?: AsyncTmuxRunner} = {},
): Promise<boolean> {
	const traceDone = startupTrace.current?.begin('attachment');
	const {signal} = options;
	const run: AsyncTmuxRunner = async args => {
		signal?.throwIfAborted();
		const output = await (options.run ?? runTmux)(args);
		signal?.throwIfAborted();
		return output;
	};
	if (signal?.aborted) {
		traceDone?.('cancelled');
		return false;
	}
	const paneIds = JSON.stringify([agentViewerPaneId, companionViewerPaneId]);
	if (viewerPaneIds !== paneIds) {
		clearCurrentlyViewingSpace();
		viewerPaneIds = paneIds;
	}
	if (currentlyViewingSpace === issueKey) {
		traceDone?.();
		return true;
	}
	// An interrupted switch may have moved only one pane. Never let the
	// previous space's cache short-circuit the next request in that case.
	currentlyViewingSpace = null;
	const sessions = getSessionNames(issueKey);
	if (
		agentViewerHasClient &&
		agentViewerTty &&
		(!companionViewerPaneId || (companionViewerHasClient && companionViewerTty))
	) {
		try {
			const commands = [
				'switch-client',
				'-c',
				agentViewerTty,
				'-t',
				exactSessionTarget(sessions.agent),
			];
			if (companionViewerPaneId) {
				commands.push(
					';',
					'switch-client',
					'-c',
					companionViewerTty!,
					'-t',
					exactSessionTarget(sessions.companion),
				);
			}
			// After the switches, so a session not created yet still fails as a
			// missing session.
			commands.push(
				';',
				...viewerSessionArgs(sessions.agent, agentFrameTitle(issueKey)),
			);
			if (companionViewerPaneId)
				commands.push(
					';',
					...viewerSessionArgs(sessions.companion, COMPANION_FRAME_TITLE),
				);
			// Existing clients can switch directly. tmux validates both targets;
			// an exited client or missing session falls back to setup below.
			await run(innerTmuxArgs(commands));
			await run(
				agentTitleAndFocusArgs(agentViewerPaneId, issueKey, listPaneId),
			);
			currentlyViewingSpace = issueKey;
			traceDone?.();
			return true;
		} catch (err) {
			if (signal?.aborted) {
				traceDone?.('cancelled');
				return false;
			}
			// Sessions are created on first visit, so a workspace that hasn't been
			// opened yet always misses here, as does a viewer whose client left
			// when the session it showed ended.
			const message = `Fast workspace switch to ${issueKey} failed; retrying with session discovery`;
			if (isMissingSessionError(err)) log.debug(message);
			else log.warn(message, err instanceof Error ? err : undefined);
			clearCurrentlyViewingSpace();
			viewerPaneIds = paneIds;
		}
	}
	// The profile persisted in the space-state file (the one actually picked at
	// creation) wins over issue-title keyword matching, which remains the
	// fallback for spaces that predate profile persistence. Without it,
	// recreating a dead session could launch a different agent or model than
	// the space was created with.
	let skipPermissions = false;
	let companionCommand = DEFAULT_COMPANION_COMMAND;
	let agentProfile: ResolvedAgentProfile | undefined;
	let sessionId: string | undefined;
	try {
		const config = loadConfig();
		const profileName = savedSpaceProfile(issueKey);
		skipPermissions = getDangerouslySkipPermissions(config);
		companionCommand = getCompanionCommand(config, issueTitle, profileName);
		agentProfile = getAgentProfile(config, issueTitle, profileName);
		sessionId = readAgentSession(getRepoName(), issueKey, agentProfile.name);
	} catch {
		// Config load failed — use safe defaults.
	}

	try {
		// Complete session creation and command launch together so a superseded
		// selection can't leave an existing session with no agent running.
		const prepared = await Promise.allSettled([
			ensureAgentSession(
				issueKey,
				mainWorktreePath,
				skipPermissions,
				options.run ?? runTmux,
				agentProfile,
				sessionId,
			),
			companionViewerPaneId
				? ensureCompanionSession(
						issueKey,
						mainWorktreePath,
						companionCommand,
						options.run ?? runTmux,
					)
				: Promise.resolve(false),
		]);
		signal?.throwIfAborted();
		const [agent, companion] = prepared;
		if (agent.status === 'rejected')
			throw new Error('Agent preparation failed', {cause: agent.reason});
		if (companion.status === 'rejected')
			throw new Error('Companion preparation failed', {
				cause: companion.reason,
			});
		const hasAgentSession = agent.value;
		const hasCompanionSession = companion.value;

		const viewersDone = startupTrace.current?.begin('viewer-attachment');
		try {
			// A frame still waiting for its first program has no client to find.
			const unstarted =
				awaitingFrames.has(agentViewerPaneId) &&
				(!companionViewerPaneId || awaitingFrames.has(companionViewerPaneId));
			const [agentTty, companionTty, clients] = unstarted
				? ['', companionViewerPaneId ? '' : null, new Set<string>()]
				: await Promise.all([
						agentViewerTty || getViewerClientTty(agentViewerPaneId, run),
						companionViewerPaneId
							? companionViewerTty ||
								getViewerClientTty(companionViewerPaneId, run)
							: null,
						innerClientTtys(run),
					]);
			const hasClient = (tty: string | null) =>
				Boolean(tty && clients.has(tty));
			// One call on the inner socket: the features a new client needs, which
			// apply when it attaches, then each session's own options.
			const sessionSetup = [
				...((hasAgentSession && !hasClient(agentTty)) ||
				(hasCompanionSession && !hasClient(companionTty))
					? [frameTerminalFeaturesArgs(), FRAME_ESCAPE_TIME_ARGS]
					: []),
				...(hasAgentSession
					? [viewerSessionArgs(sessions.agent, agentFrameTitle(issueKey))]
					: []),
				...(hasCompanionSession
					? [viewerSessionArgs(sessions.companion, COMPANION_FRAME_TITLE)]
					: []),
			];
			if (sessionSetup.length > 0)
				await run(
					innerTmuxArgs(
						sessionSetup.flatMap((args, index) =>
							index === 0 ? args : [';', ...args],
						),
					),
				);

			const attach = async (
				paneId: string,
				tty: string | null,
				session: string,
				exists: boolean,
				title: string,
				program: 'agent' | 'companion',
			): Promise<{attached: boolean; tty: string}> => {
				if (exists && hasClient(tty)) {
					await switchClientToSession(tty!, session, run);
					return {attached: true, tty: tty!};
				}
				const command = exists
					? [
							'tmux',
							...innerTmuxArgs(['attach', '-t', exactSessionTarget(session)]),
						]
							.map(value => shellQuote(value))
							.join(' ')
					: viewerNoSessionCommand(issueKey, program);
				await run(viewerStartArgs(paneId, command, title));
				// The fast path finds the respawned frame's nested client by its tty.
				return {
					attached: exists,
					tty: exists ? await awaitViewerClientTty(paneId, run) : '',
				};
			};
			const attached = await Promise.allSettled([
				attach(
					agentViewerPaneId,
					agentTty,
					sessions.agent,
					hasAgentSession,
					agentFrameTitle(issueKey),
					'agent',
				),
				companionViewerPaneId
					? attach(
							companionViewerPaneId,
							companionTty,
							sessions.companion,
							hasCompanionSession,
							COMPANION_FRAME_TITLE,
							'companion',
						)
					: Promise.resolve(null),
			]);
			signal?.throwIfAborted();
			const [agentAttachment, companionAttachment] = attached;
			if (agentAttachment.status === 'rejected')
				throw new Error('Agent attachment failed', {
					cause: agentAttachment.reason,
				});
			if (companionAttachment.status === 'rejected') {
				const {stderr} = companionAttachment.reason as {stderr?: string};
				if (!PANE_GONE.test(stderr ?? ''))
					throw new Error('Companion attachment failed', {
						cause: companionAttachment.reason,
					});
				closedCompanionPanes.add(companionViewerPaneId);
				log.info(
					`Companion pane ${companionViewerPaneId} has closed; showing the agent only`,
				);
			}

			await run(
				agentTitleAndFocusArgs(agentViewerPaneId, issueKey, listPaneId),
			);
			({attached: agentViewerHasClient, tty: agentViewerTty} =
				agentAttachment.value);
			if (
				companionAttachment.status === 'fulfilled' &&
				companionAttachment.value
			) {
				({attached: companionViewerHasClient, tty: companionViewerTty} =
					companionAttachment.value);
			}
			viewersDone?.();
		} catch (error) {
			viewersDone?.(signal?.aborted ? 'cancelled' : 'failed');
			throw error;
		}
		currentlyViewingSpace = issueKey;
		traceDone?.();
		return true;
	} catch (err) {
		// A respawn can recycle a pty even when its sibling attachment fails.
		clearCurrentlyViewingSpace();
		if (!signal?.aborted) {
			log.error(
				`Failed to attach to space ${issueKey}`,
				err instanceof Error ? err : undefined,
			);
		}
		traceDone?.(signal?.aborted ? 'cancelled' : 'failed');
		return false;
	}
}

async function innerSessionExistsAsync(
	session: string,
	run: AsyncTmuxRunner,
): Promise<boolean> {
	try {
		await run(
			innerTmuxArgs(['has-session', '-t', exactSessionTarget(session)]),
		);
		return true;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') throw error;
		return false;
	}
}

/**
 * Display a message in a pane (for empty state)
 */
export function displayMessageInPane(paneId: string, message: string): boolean {
	// The companion viewer does not exist in the vertical layout.
	if (!paneId) return false;
	forgetViewerClient(paneId);
	const result = spawnSync(
		'tmux',
		viewerStartArgs(paneId, viewerMessageCommand(message)),
		{encoding: 'utf-8', timeout: 5000},
	);
	if (result.error || result.status !== 0) {
		log.error(`Failed to display message in pane ${paneId}: ${result.stderr}`);
		return false;
	}
	return true;
}

export async function displayMessageInPaneAsync(
	paneId: string,
	message: string,
	run: AsyncTmuxRunner = runTmux,
): Promise<void> {
	if (!paneId) return;
	forgetViewerClient(paneId);
	try {
		await run(viewerStartArgs(paneId, viewerMessageCommand(message)));
	} catch (err) {
		log.error(
			`Failed to display message in pane ${paneId}`,
			err instanceof Error ? err : undefined,
		);
	}
}

// A respawned viewer pane has a new pty and no nested client, so the cached
// attachment must not drive the switch-client fast path.
function forgetViewerClient(paneId: string): void {
	if (viewerPaneIds?.includes(JSON.stringify(paneId))) {
		clearCurrentlyViewingSpace();
	}
}

/**
 * Get the currently viewing space (for state tracking)
 */
export function getCurrentlyViewingSpace(): string | null {
	return currentlyViewingSpace;
}

/**
 * Clear the currently viewing state (e.g., on shutdown)
 */
export function clearCurrentlyViewingSpace(): void {
	currentlyViewingSpace = null;
	agentViewerHasClient = false;
	companionViewerHasClient = false;
	agentViewerTty = null;
	companionViewerTty = null;
	viewerPaneIds = null;
}

/**
 * Kill a tmux pane by ID.
 * Returns true if pane was killed or didn't exist.
 */
async function killPane(
	paneId: string,
	run: AsyncTmuxRunner,
): Promise<boolean> {
	if (!paneId) return true;
	try {
		const result = await runLayoutCommand(['kill-pane', '-t', paneId], run);
		if (result.error || result.status !== 0) {
			if (PANE_GONE.test(result.stderr ?? '')) return true;
			log.warn(`Failed to kill pane ${paneId}: ${result.stderr}`);
			return false;
		}

		log.debug(`Killed pane ${paneId}`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rebuild the tmux pane layout when the layout direction changes.
 * Kills old viewer panes and creates new ones with the correct orientation.
 *
 * The list pane (where the TUI runs) is preserved — only viewer panes
 * are destroyed and recreated.
 *
 * Returns the rebuilt layout and its measured geometry, or null on failure.
 */
export async function rebuildLayout(
	listPaneId: string,
	oldAgentViewerPaneId: string,
	oldCompanionViewerPaneId: string,
	run: AsyncTmuxRunner = runTmux,
	snapshot?: WindowGeometry,
): Promise<{layout: PaneLayout; geometry: WindowGeometry} | null> {
	try {
		const windowDims = (
			snapshot ?? parseWindowGeometry(await run(paneGeometryArgs(listPaneId)))
		).window;

		// Detach any nested clients before killing panes
		if (oldAgentViewerPaneId) {
			if (agentViewerHasClient) {
				await run(['send-keys', '-t', oldAgentViewerPaneId, 'C-b', 'd']);
			}
			await killPane(oldAgentViewerPaneId, run);
		}
		if (oldCompanionViewerPaneId) {
			if (companionViewerHasClient) {
				await run(['send-keys', '-t', oldCompanionViewerPaneId, 'C-b', 'd']);
			}
			await killPane(oldCompanionViewerPaneId, run);
		}

		// Reset cached state since panes are destroyed
		agentViewerHasClient = false;
		companionViewerHasClient = false;
		agentViewerTty = null;
		companionViewerTty = null;
		currentlyViewingSpace = null;

		const cwd = process.cwd();

		const {width: totalWidth, height: totalHeight} = windowDims;
		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Rebuilding layout: ${totalWidth}x${totalHeight}, mode=${layout.direction}`,
		);

		let agentViewerPaneId: string;
		let companionViewerPaneId = '';

		if (layout.direction === 'vertical') {
			// VERTICAL: list on top, agent below
			const agentResult = await runLayoutCommand(
				[
					'split-window',
					'-v',
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(layout.agentHeight),
					'-P',
					'-F',
					'#{pane_id}',
				],
				run,
			);

			if (agentResult.error || agentResult.status !== 0) {
				log.error(
					`Rebuild: failed to create agent viewer pane: ${agentResult.stderr}`,
				);
				return null;
			}
			agentViewerPaneId = agentResult.stdout.trim();

			log.info(
				`Rebuilt vertical: list=${layout.listHeight}, agent=${layout.agentHeight}`,
			);
		} else {
			// HORIZONTAL: list | claude | companion
			const rightPortionWidth =
				(layout.agentWidth ?? 40) + (layout.companionWidth ?? 0) + 1;

			const agentResult = await runLayoutCommand(
				[
					'split-window',
					'-h',
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(rightPortionWidth),
					'-P',
					'-F',
					'#{pane_id}',
				],
				run,
			);

			if (agentResult.error || agentResult.status !== 0) {
				log.error(
					`Rebuild: failed to create agent viewer pane: ${agentResult.stderr}`,
				);
				return null;
			}
			agentViewerPaneId = agentResult.stdout.trim();

			if ((layout.companionWidth ?? 0) >= MIN_COMPANION_WIDTH) {
				const companionResult = await runLayoutCommand(
					[
						'split-window',
						'-h',
						'-t',
						agentViewerPaneId,
						'-c',
						cwd,
						'-l',
						String(layout.companionWidth),
						'-P',
						'-F',
						'#{pane_id}',
					],
					run,
				);

				if (!companionResult.error && companionResult.status === 0) {
					companionViewerPaneId = companionResult.stdout.trim();
				}
			}

			log.info(
				`Rebuilt horizontal: list=${layout.listWidth}, agent=${layout.agentWidth}, companion=${layout.companionWidth}`,
			);
		}

		try {
			await run(viewerTitleArgs(agentViewerPaneId, companionViewerPaneId));
		} catch {
			// Non-fatal
		}

		// Return focus to list pane
		await runLayoutCommand(['select-pane', '-t', listPaneId], run);

		log.info(
			`Layout rebuilt: agent=${agentViewerPaneId}, companion=${companionViewerPaneId || '(none)'}`,
		);

		const geometry = await recordPaneSampleAsync(
			listPaneId,
			companionViewerPaneId,
			run,
		);
		return {
			layout: {listPaneId, agentViewerPaneId, companionViewerPaneId},
			geometry,
		};
	} catch (err) {
		log.error(
			'Failed to rebuild layout',
			err instanceof Error ? err : undefined,
		);
		return null;
	}
}

async function relayoutGeometry(
	listPaneId: string,
	companionViewerPaneId: string,
	run: AsyncTmuxRunner,
	snapshot?: WindowGeometry,
): Promise<WindowGeometry | null> {
	try {
		// Get current terminal dimensions from the window (not individual panes)
		const geometry =
			snapshot ?? parseWindowGeometry(await run(paneGeometryArgs(listPaneId)));
		const windowDims = geometry.window;

		const {width: totalWidth, height: totalHeight} = windowDims;

		// Separate a window resize from a hand-drag of a side-pane border
		// *before* computing the layout, so a drag feeds its own width back in
		// instead of being recomputed away. See pane-drag.ts and STA-2040.
		const measuredRail = paneGeometry(geometry, listPaneId);
		let resizeAttempted = false;
		const measuredRailWidth = measuredRail.cols;
		const measuredCompanionWidth =
			geometry.panes.get(companionViewerPaneId)?.cols ?? null;
		const previousRail = railWidthOverride;
		const previousCompanion = companionWidthOverride;
		railWidthOverride = nextWidthOverride({
			previousWindow: lastWindowSize,
			currentWindow: windowDims,
			previousWidth: lastRailWidth,
			currentWidth: measuredRailWidth,
			currentOverride: railWidthOverride,
		});
		companionWidthOverride = nextWidthOverride({
			previousWindow: lastWindowSize,
			currentWindow: windowDims,
			previousWidth: lastCompanionWidth,
			currentWidth: measuredCompanionWidth,
			currentOverride: companionWidthOverride,
		});
		// A configured claude width can be what sized the other side pane, and
		// that width is dropped once anything is dragged. Pinning the other side
		// keeps it where it was instead of jumping to its derived width.
		if (getConfiguredPaneWidths().claude !== undefined) {
			if (railWidthOverride !== previousRail)
				companionWidthOverride ??= measuredCompanionWidth;
			if (companionWidthOverride !== previousCompanion)
				railWidthOverride ??= measuredRailWidth;
		}

		if (railWidthOverride !== previousRail) {
			log.info(
				`Rail resized by hand: width=${railWidthOverride} (was ${previousRail ?? 'default'})`,
			);
		}

		if (companionWidthOverride !== previousCompanion) {
			log.info(
				`Companion resized by hand: width=${companionWidthOverride} (was ${previousCompanion ?? 'default'})`,
			);
		}

		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Relayout: ${totalWidth}x${totalHeight}, mode=${layout.direction}` +
				(railWidthOverride === null ? '' : `, rail=${railWidthOverride}`) +
				(companionWidthOverride === null
					? ''
					: `, companion=${companionWidthOverride}`),
		);

		if (layout.direction === 'vertical') {
			// Vertical: resize list pane height, claude gets remainder
			if (
				layout.listHeight !== undefined &&
				layout.listHeight !== measuredRail.rows
			) {
				resizeAttempted = true;
				const result = await runLayoutCommand(
					['resize-pane', '-t', listPaneId, '-y', String(layout.listHeight)],
					run,
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize list pane height: ${result.stderr}`);
					return null;
				}
			}
		} else {
			// Horizontal: resize list width and companion width, claude gets remainder
			const resizeRail =
				layout.listWidth !== undefined &&
				layout.listWidth !== measuredRailWidth;
			if (resizeRail) {
				resizeAttempted = true;
				const result = await runLayoutCommand(
					['resize-pane', '-t', listPaneId, '-x', String(layout.listWidth)],
					run,
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize list pane width: ${result.stderr}`);
					return null;
				}
			}

			if (
				measuredCompanionWidth !== null &&
				layout.companionWidth !== undefined &&
				(resizeRail || layout.companionWidth !== measuredCompanionWidth)
			) {
				resizeAttempted = true;
				const result = await runLayoutCommand(
					[
						'resize-pane',
						'-t',
						companionViewerPaneId,
						'-x',
						String(layout.companionWidth),
					],
					run,
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize companion pane width: ${result.stderr}`);
					// Non-fatal, continue
				}
			}
		}

		const measured = resizeAttempted
			? await recordPaneSampleAsync(listPaneId, companionViewerPaneId, run)
			: geometry;
		if (!resizeAttempted)
			recordGeometry(measured, listPaneId, companionViewerPaneId);

		log.info('Relayout completed successfully');
		return measured;
	} catch (err) {
		log.error(
			'Failed to relayout panes',
			err instanceof Error ? err : undefined,
		);
		return null;
	}
}

export async function reconcilePaneLayout(
	layout: PaneLayout,
	zoomed: boolean,
	run: AsyncTmuxRunner = runTmux,
): Promise<{layout: PaneLayout; dimensions: {rows: number; cols: number}}> {
	let geometry = parseWindowGeometry(
		await run(paneGeometryArgs(layout.listPaneId)),
	);
	if (geometry.window.zoomed !== zoomed) {
		await run(['resize-pane', '-Z', '-t', layout.listPaneId]);
		geometry = parseWindowGeometry(
			await run(paneGeometryArgs(layout.listPaneId)),
		);
	}
	if (!zoomed) {
		const vertical =
			paneGeometry(geometry, layout.listPaneId).cols === geometry.window.width;
		const desiredVertical = geometry.window.width < NARROW_SCREEN_THRESHOLD;
		if (vertical !== desiredVertical) {
			const rebuilt = await rebuildLayout(
				layout.listPaneId,
				layout.agentViewerPaneId,
				layout.companionViewerPaneId,
				run,
				geometry,
			);
			if (!rebuilt) throw new Error('Failed to rebuild pane layout');
			({layout, geometry} = rebuilt);
		} else {
			const measured = await relayoutGeometry(
				layout.listPaneId,
				layout.companionViewerPaneId,
				run,
				geometry,
			);
			if (!measured) throw new Error('Failed to resize pane layout');
			geometry = measured;
		}
	}
	return {layout, dimensions: paneGeometry(geometry, layout.listPaneId)};
}

/**
 * Get the worktree path for an issue key
 */
export function getWorktreePath(issueKey: string): string | null {
	try {
		const homeDir = process.env['HOME'] ?? '';
		const repoName = getRepoName();
		const worktreePath = `${homeDir}/.worktrees/${repoName}/${issueKey}`;

		return existsSync(worktreePath) && statSync(worktreePath).isDirectory()
			? worktreePath
			: null;
	} catch {
		return null;
	}
}

export async function getWorktreePathAsync(
	issueKey: string,
	repoName: string,
): Promise<string | null> {
	const worktreePath = join(
		process.env['HOME'] ?? '',
		'.worktrees',
		repoName,
		issueKey,
	);
	try {
		const stats = await stat(worktreePath);
		return stats.isDirectory() ? worktreePath : null;
	} catch (err) {
		if (
			['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')
		)
			return null;
		throw err;
	}
}

/**
 * Get the main worktree info (path and branch name).
 * The main worktree is the original git checkout (not a `git worktree add` worktree).
 * Returns null if detection fails.
 */
export async function getMainWorktreeInfo(): Promise<{
	path: string;
	branch: string;
} | null> {
	const done = startupTrace.current?.begin('main-discovery');
	try {
		// `git worktree list --porcelain` outputs blocks like:
		//   worktree /path/to/repo
		//   HEAD abc123
		//   branch refs/heads/master
		//
		// The first block is always the main worktree.
		const {stdout} = await execAsync('git worktree list --porcelain', {
			encoding: 'utf-8',
			timeout: 5000,
		});

		const lines = stdout.split('\n');
		let path: string | null = null;
		let branch: string | null = null;

		for (const line of lines) {
			if (line.startsWith('worktree ') && !path) {
				path = line.slice('worktree '.length);
			} else if (line.startsWith('branch ') && !branch) {
				// e.g. "branch refs/heads/master" → "master"
				branch = line.slice('branch '.length).replace('refs/heads/', '');
			} else if (line === '' && path) {
				// End of first worktree block
				break;
			}
		}

		if (path && branch) {
			done?.();
			return {path, branch};
		}
		done?.('unavailable');
		return null;
	} catch {
		done?.('failed');
		return null;
	}
}

/**
 * Pre-trust a directory for Claude Code by writing hasTrustDialogAccepted
 * to ~/.claude.json. Without this, every new worktree directory triggers
 * a "do you trust this folder?" prompt that blocks the interactive session.
 *
 * This trust dialog was introduced in Claude Code v2.1.53 for directories
 * with risky project settings (e.g. .claude/commands/ with Bash tool access).
 */
export function pretrustDirectoryForClaude(
	worktreePath: string,
	configPath?: string,
): void {
	const resolvedConfigPath =
		configPath ??
		process.env['PAPPARDELLE_CLAUDE_CONFIG_PATH'] ??
		join(homedir(), '.claude.json');
	try {
		let config: Record<string, unknown> = {};
		try {
			config = JSON.parse(readFileSync(resolvedConfigPath, 'utf-8'));
		} catch {
			// File doesn't exist or is invalid JSON - start fresh
		}

		const projects = (config['projects'] ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		if (!projects[worktreePath]) {
			projects[worktreePath] = {};
		}
		if (!projects[worktreePath]!['hasTrustDialogAccepted']) {
			projects[worktreePath]!['hasTrustDialogAccepted'] = true;
			config['projects'] = projects;
			writeFileSync(
				resolvedConfigPath,
				JSON.stringify(config, null, 2),
				'utf-8',
			);
			log.info(`Pre-trusted directory for Claude: ${worktreePath}`);
		}
	} catch (err) {
		log.warn(
			`Failed to pre-trust directory for Claude: ${worktreePath}`,
			err instanceof Error ? err : undefined,
		);
	}
}

/**
 * The session environment for a space the TUI makes itself. A failure to find
 * the main checkout must not stop the session: the hook can still work it out.
 */
function spaceSessionEnvArgs(issueKey: string): string[] {
	let mainRepoRoot: string | undefined;
	try {
		mainRepoRoot = getMainRepoRoot();
	} catch {
		// Leave it unset
	}

	return buildSessionEnvArgs(issueKey, mainRepoRoot);
}

const STARTUP_GATE_OPTION = '@pappardelle_startup_gate';

// A space's sessions are only ever seen nested in a viewer pane, where the
// user's own status bar would add a row naming the session under the rail's
// own header.
// The inner server loads the user's tmux.conf. With destroy-unattached on,
// tmux destroys every session no client is viewing, which is every background
// agent. With exit-unattached on, the server exits once no client is attached,
// taking the agents with it when the TUI quits.
const KEEP_UNVIEWED_SESSIONS_ARGS = [
	';',
	'set-option',
	'-g',
	'destroy-unattached',
	'off',
	';',
	'set-option',
	'-s',
	'exit-unattached',
	'off',
];

function hideStatusBarArgs(sessionName: string): string[] {
	return [
		';',
		'set-option',
		'-t',
		exactSessionTarget(sessionName),
		'status',
		'off',
	];
}

async function attachStartupMonitor(
	issueKey: string,
	session: string,
	run: AsyncTmuxRunner,
): Promise<void> {
	const done = startupTrace.current?.begin('monitor-ready');
	try {
		const pane = await attachStatusMonitor(
			getRepoName(),
			issueKey,
			session,
			statusSocket(),
			run,
		);
		done?.(pane && !pane.dead ? 'ok' : 'unavailable');
	} catch (error) {
		done?.('failed');
		throw error;
	}
}

async function releaseStartupGate(
	session: string,
	run: AsyncTmuxRunner,
	gate?: string,
): Promise<void> {
	if (gate === undefined) {
		const pending = await run(
			innerTmuxArgs([
				'show-option',
				'-qv',
				'-t',
				exactSessionTarget(session),
				STARTUP_GATE_OPTION,
			]),
		);
		gate = pending.trim();
	}
	if (!gate) return;
	const commands = [
		['wait-for', '-S', gate],
		[
			'set-option',
			'-u',
			'-t',
			exactSessionTarget(session),
			STARTUP_GATE_OPTION,
		],
	]
		.map(args => args.map(value => shellQuote(value)).join(' '))
		.join(' ; ');
	await run(
		innerTmuxArgs([
			'if-shell',
			'-F',
			'-t',
			exactSessionTarget(session),
			`#{==:#{${STARTUP_GATE_OPTION}},${gate}}`,
			commands,
			'',
		]),
	);
}

/**
 * Create an agent session for an issue if it doesn't exist
 * Returns true if session exists or was created successfully
 *
 * The session outlives the agent: a login shell takes over the pane when the
 * agent exits (see buildShellLaunchArgs).
 */
export async function ensureAgentSession(
	issueKey: string,
	explicitWorktreePath?: string,
	skipPermissions = false,
	run: AsyncTmuxRunner = runTmux,
	agentProfile: ResolvedAgentProfile = DEFAULT_RESOLVED_AGENT_PROFILE,
	sessionId?: string,
): Promise<boolean> {
	const traceDone = startupTrace.current?.begin('agent-session');
	const sessions = getSessionNames(issueKey);
	const sessionName = sessions.agent;

	// Already exists on the inner socket?
	if (await innerSessionExistsAsync(sessionName, run)) {
		try {
			await attachStartupMonitor(issueKey, sessionName, run);
			await releaseStartupGate(sessionName, run);
			traceDone?.();
			return true;
		} catch (err) {
			log.error(
				`Failed to resume agent startup for ${issueKey}`,
				err instanceof Error ? err : undefined,
			);
			traceDone?.('failed');
			return false;
		}
	}

	const worktreePath = explicitWorktreePath ?? getWorktreePath(issueKey);
	if (!worktreePath) {
		log.warn(`Cannot create agent session for ${issueKey}: no worktree found`);
		traceDone?.('failed');
		return false;
	}

	// Pre-trust the worktree directory so Claude doesn't ask "do you trust this
	// folder?" — a Claude Code behavior, skipped for other agents.
	if (agentProfile.isClaude) {
		pretrustDirectoryForClaude(worktreePath);
	}

	// Native agents report at startup, before an ungated monitor could attach.
	const gate = `pappardelle-status-${randomUUID()}`;
	const launchArgs = [
		'/bin/sh',
		'-c',
		'tmux "$1" "$2" wait-for "$3"; shift 3; exec "$@"',
		'sh',
		...innerTmuxArgs([]),
		gate,
		...buildShellLaunchArgs(
			buildAgentResumeCommand(
				issueKey,
				skipPermissions,
				agentProfile,
				sessionId,
			),
			true,
		),
	];

	try {
		await run(
			innerTmuxArgs([
				'new-session',
				'-d',
				'-s',
				sessionName,
				'-c',
				worktreePath,
				...spaceSessionEnvArgs(issueKey),
				...buildAgentSessionEnvArgs(
					agentProfile,
					getAgentSessionsPath(getRepoName(), issueKey),
				),
				...launchArgs,
				';',
				'set-option',
				'-t',
				exactSessionTarget(sessionName),
				STARTUP_GATE_OPTION,
				gate,
				...hideStatusBarArgs(sessionName),
				...KEEP_UNVIEWED_SESSIONS_ARGS,
			]),
		);
		try {
			await attachStartupMonitor(issueKey, sessionName, run);
		} finally {
			await releaseStartupGate(sessionName, run, gate);
		}

		log.info(
			`Created agent session: ${sessionName} (agent profile: ${agentProfile.name})`,
		);
		traceDone?.();
		return true;
	} catch (err) {
		log.error(
			`Failed to create agent session for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		traceDone?.('failed');
		return false;
	}
}

/**
 * Create a companion session for an issue if it doesn't exist
 * Returns true if session exists or was created successfully
 *
 * Like claude sessions, a login shell takes over the pane when the command
 * exits.
 *
 * `companionCommand` is the shell command run in the pane — defaults to gitui
 * (see DEFAULT_COMPANION_COMMAND) and is overridable via the `companion_command`
 * config field. An empty/whitespace-only command leaves a plain shell.
 */
export async function ensureCompanionSession(
	issueKey: string,
	explicitWorktreePath?: string,
	companionCommand: string = DEFAULT_COMPANION_COMMAND,
	run: AsyncTmuxRunner = runTmux,
): Promise<boolean> {
	const traceDone = startupTrace.current?.begin('companion-session');
	const sessionName = getSessionNames(issueKey).companion;

	// Already exists on the inner socket?
	if (await innerSessionExistsAsync(sessionName, run)) {
		traceDone?.();
		return true;
	}

	const worktreePath = explicitWorktreePath ?? getWorktreePath(issueKey);
	if (!worktreePath) {
		log.warn(
			`Cannot create companion session for ${issueKey}: no worktree found`,
		);
		traceDone?.('failed');
		return false;
	}

	try {
		// An empty command means "leave a plain shell". The default command
		// carries GIT_OPTIONAL_LOCKS=0, which keeps the git UI from acquiring
		// locks for read-only ops like `git status`, avoiding contention with
		// Claude's concurrent git calls. Custom commands run verbatim.
		const launchArgs =
			companionCommand.trim() === ''
				? []
				: buildShellLaunchArgs(companionCommand);
		await run(
			innerTmuxArgs([
				'new-session',
				'-d',
				'-s',
				sessionName,
				'-c',
				worktreePath,
				...spaceSessionEnvArgs(issueKey),
				...launchArgs,
				...hideStatusBarArgs(sessionName),
				...KEEP_UNVIEWED_SESSIONS_ARGS,
			]),
		);

		log.info(`Created companion session: ${sessionName}`);
		traceDone?.();
		return true;
	} catch (err) {
		log.error(
			`Failed to create companion session for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		traceDone?.('failed');
		return false;
	}
}
