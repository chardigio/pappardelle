// Tmux session attachment for pappardelle
// Attaches to existing agent-STA-XXX and companion-STA-XXX sessions created by idow
import {execFile, spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';

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
	DEFAULT_RESOLVED_AGENT_PROFILE,
	checkAgentProfile,
	type ConfigLoad,
	getNamedAgentProfile,
	getSpaceAgentProfile,
	getCompanionCommand,
	getCompanionSplits,
	getDangerouslySkipPermissions,
	getMainRepoRoot,
	getListLayout,
	getPaneWidths,
	getRepoName,
	readConfig,
	type ResolvedCompanionSplit,
	type PappardelleConfig,
	type ResolvedAgentProfile,
	SOUS_CHEF_NAME,
	sousChefLaunch,
	spaceAgentProfileName,
	type AgentLaunch,
	workspaceAwareAgents,
} from './config.ts';
import {
	AGENT_NAME_FALLBACK,
	agentDisplayName,
	bindResumeArgs,
	isAgyCommand,
	renderAgentLaunchFlags,
	renderAgentPrompt,
	quoteLaunchValue,
} from './config-launch-flags.ts';
import {agentRulesFlags, installAgentRules} from './companion-rules.ts';
import {
	MAIN_PANE,
	SPLIT_LIST_FORMAT,
	owningCompanionSession,
	parseCompanionListing,
	splitOptionArgs,
	splitTargets,
	splitSessionName,
	splitSignature,
	type CompanionListing,
	type CompanionSplit,
	type SplitDirection,
} from './companion-splits.ts';
import {createLogger} from './logger.ts';
import {readReportedConfig, reportWhileInvalid} from './config-report.ts';
import {
	ControlClientNeverStarted,
	TmuxControlClient,
	controlCommandLine,
	quoteTmuxArgument,
} from './tmux-control.ts';
import {
	CLIENT_TTY_OPTION,
	FRAME_COMMAND_OPTION,
	PANE_FRAME_SIZE,
	PANE_TITLE_OPTION,
	frameReadyChannel,
	frameStartedChannel,
} from './pane-frame-options.ts';
import {
	type AgentScreen,
	type AgyComposerState,
	parseAgentScreen,
} from './agent-screen.ts';
import {internalEntryCommand} from './runtime.ts';
import {startupTrace} from './startup-trace.ts';
import type {PaneLayout} from './types.ts';
import {
	paneGeometryArgs,
	parseWindowGeometry,
	paneGeometry,
	type PaneGeometry,
	type WindowGeometry,
} from './tmux-geometry.ts';
import {sameFile} from './same-file.ts';
import {SendLockTimeout, withSendLock} from './send-lock.ts';
import {tmuxFormatLiteral} from './tmux-format.ts';
import {shellQuote} from './shell-quote.ts';
import {buildAgentSessionEnvArgs, buildSessionEnvArgs} from './spawn-env.ts';
import {listOpenSpaces, type SpaceRegistryDao} from './space-registry.ts';
import {listKnownRepos} from './state-db.ts';
import type {StateDaos} from './state-daos.ts';
import {QaSimulatorCleanup} from './qa-simulator.ts';
import type {AgentSessionsDao} from './agent-sessions.ts';
import type {SpaceStateDao} from './space-state.ts';
import {
	legacyAgentSession,
	sessionPrefix,
	tmuxSessionRepo,
	type ProtectedSessions,
	SESSION_KINDS,
	type SpaceIdentity,
	type SpaceIdentityDao,
	type SpaceSessionNames,
} from './space-identity.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {
	calculateIdealListHeightForCount,
	calculateLayoutForSize,
	MIN_COMPANION_WIDTH,
	NARROW_SCREEN_THRESHOLD,
	type LayoutConfig,
	type PaneWidth,
	type PaneWidths,
} from './layout-sizing.ts';
import {nextSizeOverride, type WindowSize} from './pane-drag.ts';
import {
	AGENT_PANE_FORMAT,
	statusPaneOf,
	statusSocket,
	statusTmuxArgs,
	type ProgramStatusDao,
	type ProgramStatusSnapshot,
	type StatusPane,
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

let stateDaos: StateDaos | undefined;

/**
 * Give this module the stores its functions read. They are free functions
 * with long call chains, so the stores are handed over once at startup
 * instead of through every signature.
 */
export function initTmuxState(daos: StateDaos): void {
	stateDaos = daos;
}

function registry(): SpaceRegistryDao {
	if (!stateDaos) throw new Error('initTmuxState() was not called');
	return stateDaos.registry;
}

function spaceState(): SpaceStateDao {
	if (!stateDaos) throw new Error('initTmuxState() was not called');
	return stateDaos.spaceState;
}

function agentSessions(): AgentSessionsDao {
	if (!stateDaos) throw new Error('initTmuxState() was not called');
	return stateDaos.agentSessions;
}

function spaceIdentities(): SpaceIdentityDao {
	if (!stateDaos) throw new Error('initTmuxState() was not called');
	return stateDaos.spaceIdentities;
}

function programStatus(): ProgramStatusDao {
	if (!stateDaos) throw new Error('initTmuxState() was not called');
	return stateDaos.programStatus;
}

const reportedUnknown = new Set<string>();

/**
 * A space's stored identity, or null after logging why it has none. Callers
 * then fail the way they do when the space's session is missing.
 */
export function storedIdentity(issueKey: string): SpaceIdentity | null {
	const lookup = spaceIdentities().get(issueKey);
	if (lookup.kind === 'identity') return lookup.identity;
	if (lookup.kind === 'unknown') {
		// The rail asks again on every refresh.
		if (!reportedUnknown.has(issueKey))
			log.warn(`No stored identity for ${issueKey}`);
		reportedUnknown.add(issueKey);
	} else
		log.warn(
			`Could not read the stored identity of ${issueKey}`,
			lookup.error instanceof Error ? lookup.error : undefined,
		);
	return null;
}

function reportHeldBack(issueKey: string): void {
	reportWhileInvalid(
		`Sessions of ${issueKey} not started: the config is invalid`,
	);
}

function sessionNamesOf(identity: SpaceIdentity): SpaceSessionNames {
	return {
		agent: identity.tmux.agentSession,
		companion: identity.tmux.companionSession,
	};
}

/** A space's stored session names, or null when it has none. */
export function spaceSessionNames(issueKey: string): SpaceSessionNames | null {
	const identity = storedIdentity(issueKey);
	return identity && sessionNamesOf(identity);
}

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
 * The selected space's own companion width, set by `pappardelle companion
 * width`, or null when the space has none. It beats the drag override and the
 * config. A hand-drag while it applies changes this width, and is handed to
 * `onSpaceCompanionDrag` to store, instead of becoming the session-wide drag
 * override.
 */
let spaceCompanionWidth: {key: string; width: PaneWidth} | null = null;
let onSpaceCompanionDrag: ((key: string, columns: number) => void) | null =
	null;

export function setSpaceCompanionWidth(
	value: {key: string; width: PaneWidth} | null,
): void {
	spaceCompanionWidth = value;
}

export function setSpaceCompanionDragHandler(
	handler: ((key: string, columns: number) => void) | null,
): void {
	onSpaceCompanionDrag = handler;
}

/**
 * Window size and measured side-pane widths at the end of the previous
 * relayout.
 *
 * Together they let `nextSizeOverride` separate a window resize from a
 * hand-drag of a pane border. Measured, not requested, so tmux rounding never
 * reads as a drag.
 */
let lastWindowSize: WindowSize | null = null;
let lastRailWidth: number | null = null;
let lastCompanionWidth: number | null = null;

let configuredPaneWidths: PaneWidths | undefined;

/** Replace the configured pane widths, which are otherwise read once from the repo config. */
export function setConfiguredPaneWidthsForTests(widths: PaneWidths): void {
	configuredPaneWidths = widths;
}

function getConfiguredPaneWidths(): PaneWidths {
	if (configuredPaneWidths === undefined) {
		const load = readReportedConfig();
		configuredPaneWidths =
			load.kind === 'valid' ? getPaneWidths(load.config) : {};
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
		const load = readReportedConfig();
		configuredListLines =
			load.kind === 'valid' && getListLayout(load.config) === 'two_line'
				? 2
				: 1;
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
	const result = defaultOuterTmuxRunner([
		'has-session',
		'-t',
		exactSessionTarget(sessionName),
	]);
	return !result.error && result.status === 0;
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
		frameHostCommand(command, title),
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
	return [
		...internalEntryCommand('--internal-pane-frame', 'pane-frame-cli'),
		'--title',
		title,
		'--await',
	]
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

/**
 * The shell command a viewer pane runs: the frame host around `command`, then
 * a login shell. A split's pane has no shell after it, so the pane closes
 * when the split's session ends instead of leaving a shell of no space.
 */
function frameHostCommand(
	command: string,
	title?: string,
	then: 'shell' | 'close' = 'shell',
): string {
	return [
		...internalEntryCommand('--internal-pane-frame', 'pane-frame-cli'),
		...(title === undefined ? [] : ['--title', title]),
		'--',
		'/bin/sh',
		'-c',
		then === 'shell' ? `${command}; exec "$SHELL" -l` : command,
	]
		.map(value => shellQuote(value))
		.join(' ');
}

function nestedAttachCommand(session: string): string {
	return [
		'tmux',
		...innerTmuxArgs(['attach', '-t', exactSessionTarget(session)]),
	]
		.map(value => shellQuote(value))
		.join(' ');
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

const AGENT_PANE_TITLE = AGENT_NAME_FALLBACK;
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

function agentFrameTitle(agentName: string, title: string): string {
	return `${agentName} · ${title}`;
}

function agentTitleAndFocusArgs(
	agentViewerPaneId: string,
	frameTitle: string,
	listPaneId?: string,
): string[] {
	const args = paneTitleArgs(agentViewerPaneId, frameTitle);
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
		tmuxFormatLiteral(title),
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

// The sous-chef key is a root-table binding on the outer server, which every
// window shares, so it only acts where Pappardelle's window says it may: the
// window must name this exact key, and it carries the command for its own repo.
// Anywhere else, the key goes on to the pane's program.
const SOUS_CHEF_KEY_OPTION = '@pappardelle-sous-chef-key';
const SOUS_CHEF_COMMAND_OPTION = '@pappardelle-sous-chef';

function sousChefKeyArgs(
	listPaneId: string,
	key: string,
	command: string,
): string[] {
	return [
		...windowOptionArgs(listPaneId, SOUS_CHEF_KEY_OPTION, key),
		';',
		...windowOptionArgs(listPaneId, SOUS_CHEF_COMMAND_OPTION, command),
		';',
		'bind-key',
		'-n',
		key,
		'if-shell',
		'-F',
		`#{==:#{${SOUS_CHEF_KEY_OPTION}},${key}}`,
		`run-shell -b "#{${SOUS_CHEF_COMMAND_OPTION}}"`,
		`send-keys ${quoteTmuxArgument(key)}`,
	];
}

export function clearSousChefKeyArgs(listPaneId: string): string[] {
	return [
		...windowOptionArgs(listPaneId, SOUS_CHEF_KEY_OPTION, undefined),
		';',
		...windowOptionArgs(listPaneId, SOUS_CHEF_COMMAND_OPTION, undefined),
	];
}

/**
 * Bind the sous-chef key for this window, or with no key, stop a binding left
 * by an earlier run from acting here.
 */
export async function installSousChefKey(
	listPaneId: string,
	key: string | null,
	command: string,
	run: AsyncTmuxRunner = runTmux,
): Promise<void> {
	try {
		await run(
			key === null
				? clearSousChefKeyArgs(listPaneId)
				: sousChefKeyArgs(listPaneId, key, command),
		);
	} catch (error) {
		log.warn(
			`Failed to install the sous-chef key ${key ?? '(off)'}`,
			error instanceof Error ? error : undefined,
		);
	}
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
 * plus the skip-permissions flag. Model/effort/mode flags come from the agent
 * profile's templates, for any CLI that has them. Without `resumeArgs` there
 * is no resume attempt at all (a made-up resume flag would error confusingly
 * on unknown CLIs).
 *
 * The model/effort/mode flags sit before `--name` and the resume args, so a
 * subcommand like codex's `resume` still comes after every flag. Flag order
 * (`--dangerously-skip-permissions`, args, model, effort, mode, `--name`) and the
 * agent composition rule are mirrored by start-agent-session.sh and the
 * open-*-agent.sh launchers; keep them in sync so a session created by the TUI
 * and one created by idow are indistinguishable.
 */
export function buildAgentResumeCommand(
	issueKey: string,
	skipPermissions = false,
	agentProfile: ResolvedAgentProfile = DEFAULT_RESOLVED_AGENT_PROFILE,
	sessionId?: string,
	launch?: AgentLaunch,
): string {
	let base: string;
	const prompt = launch?.prompt
		? renderAgentPrompt(launch.prompt, agentProfile.promptArgs)
		: '';
	const launchFlags = `${renderAgentLaunchFlags(agentProfile)}${launch?.rules ? agentRulesFlags(agentProfile.rulesArgs) : ''}`;
	if (agentProfile.isClaude) {
		const safeKey = quoteLaunchValue(launch?.name ?? issueKey);
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
		return `${base}${prompt}`;
	}
	return `${base} ${resumeArgs}${prompt} || { printf '\\033[A\\033[2K'; false; } || ${base}${prompt}`;
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
	if (!sessionExists(sessionName)) {
		log.debug(`Session ${sessionName} does not exist, nothing to kill`);
		return true;
	}

	const result = defaultOuterTmuxRunner([
		'kill-session',
		'-t',
		exactSessionTarget(sessionName),
	]);
	if (result.error || result.status !== 0) {
		log.error(
			`Failed to kill session ${sessionName}: ${tmuxFailure(result)}`,
			result.error,
		);
		return false;
	}

	log.info(`Killed session: ${sessionName}`);
	return true;
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

export function tmuxFailure(result: ReturnType<OuterTmuxRunner>): string {
	return (
		result.stderr?.trim() ||
		result.error?.message ||
		`tmux exited ${result.status ?? 'without a status'}`
	);
}

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
	return `${OUTER_SESSION_PREFIX}${tmuxSessionRepo(repoName)}`;
}

// The rail's header already names the repo, so the user's status bar would
// only repeat it. Terminal tabs (Ghostty, iTerm2) show only title text, so the
// 🍝 there stands in for an app icon, whatever the user's own set-titles
// setting is.
export function newOuterSessionArgs(
	repoName: string,
	sessionEnvArgs: string[],
	command: string,
): string[] {
	const sessionName = outerSessionName(repoName);
	const target = exactSessionTarget(sessionName);
	return [
		'new-session',
		'-s',
		sessionName,
		...sessionEnvArgs,
		command,
		';',
		...outerDetachOnDestroyArgs(sessionName),
		';',
		'set-option',
		'-t',
		target,
		'status',
		'off',
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
		tmuxFormatLiteral(`🍝 ${repoName}`),
	];
}

// With the user's `detach-on-destroy off`, quitting one repo's TUI would move
// the terminal into another repo's outer session instead of back to the shell.
export function outerDetachOnDestroyArgs(sessionName: string): string[] {
	return [
		'set-option',
		'-t',
		exactSessionTarget(sessionName),
		'detach-on-destroy',
		'on',
	];
}

export function attachOuterSession(sessionName: string) {
	return spawnSync(
		'tmux',
		['attach-session', '-t', exactSessionTarget(sessionName)],
		{stdio: 'inherit'},
	);
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
		const repo = repoName ?? getRepoName();
		const agentPrefix = sessionPrefix('agent', repo);
		const legacyAgentPrefix = sessionPrefix('claude', repo);
		const companionPrefix = sessionPrefix('companion', repo);
		// Pre-STA-1464 the companion pane was named `lazygit-{repo}-*`. Sweep that
		// legacy prefix too so an upgrade doesn't strand old git-UI sessions.
		const legacyCompanionPrefix = sessionPrefix('lazygit', repo);

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

export function socketTmuxRunner(socket: string): OuterTmuxRunner {
	return spawnTmuxRunner(
		args => statusTmuxArgs([...args], socket),
		() => defaultServerTmuxEnv(process.env),
	);
}

const ENDING_VERBS = new Set(['kill-server', 'kill-session', 'kill-pane']);

/**
 * Supervision reads and types into other spaces' sessions but never ends one.
 * A stray `kill-server` from inside the user's tmux has taken down every
 * session on the machine before, so these runners refuse it outright.
 */
function supervisionRunner(base: OuterTmuxRunner): OuterTmuxRunner {
	return (args, input) => {
		if (ENDING_VERBS.has(args[0] ?? '')) {
			throw new Error(`Supervision never runs tmux ${args[0]}`);
		}

		return base(args, input);
	};
}

export const supervisedInnerTmuxRunner = supervisionRunner(
	spawnTmuxRunner(innerTmuxArgs, () => defaultServerTmuxEnv(process.env)),
);
export const supervisedServerTmuxRunner = supervisionRunner(
	defaultServerTmuxRunner,
);

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

// A session created while nobody views it, by the TUI or by idow, starts at
// the inner server's default-size, tmux's 80x24 unless set, and Claude Code
// hard-wraps its output to the width it started at. Setting it never resizes
// windows that already exist.
async function setInnerDefaultSize(
	geometry: WindowGeometry,
	agentViewerPaneId: string,
	run: AsyncTmuxRunner,
): Promise<void> {
	try {
		const {cols, rows} = paneGeometry(geometry, agentViewerPaneId);
		await run(
			innerTmuxArgs([
				'set-option',
				'-g',
				'default-size',
				`${cols - PANE_FRAME_SIZE}x${rows - PANE_FRAME_SIZE}`,
			]),
		);
	} catch (error) {
		log.warn(
			'Could not set the default size on the inner socket',
			error instanceof Error ? error : undefined,
		);
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
 * This repo's space sessions on the inner socket, each with the session that
 * owns it: a split's companion, and for a legacy name the session it was
 * renamed to. Null when tmux did not answer, which is not the same as none.
 */
function innerSpaceSessions(
	repoName: string | undefined,
	runner: OuterTmuxRunner,
	knownRepos: string[],
): Array<{name: string; owner: string}> | null {
	const repo = repoName ?? getRepoName();
	const agentPrefix = sessionPrefix('agent', repo);
	const companionPrefix = sessionPrefix('companion', repo);
	// Before the agent- and companion- names the panes were claude- and, before
	// STA-1464, lazygit-. A hard-quit straddling an upgrade leaves those behind.
	const legacyAgentPrefix = sessionPrefix('claude', repo);
	const legacyCompanionPrefix = sessionPrefix('lazygit', repo);
	const longerRepoPrefixes = siblingRepoPrefixes(repo, knownRepos);

	const result = runner(['list-sessions', '-F', '#{session_name}']);
	if (result.error || result.status !== 0) {
		return null;
	}

	const sessions: Array<{name: string; owner: string}> = [];
	for (const name of result.stdout.trim().split('\n')) {
		if (longerRepoPrefixes.some(prefix => name.startsWith(prefix))) continue;
		if (name.startsWith(agentPrefix) || name.startsWith(legacyAgentPrefix)) {
			sessions.push({name, owner: name});
		} else if (name.startsWith(companionPrefix)) {
			sessions.push({name, owner: owningCompanionSession(name)});
		} else if (name.startsWith(legacyCompanionPrefix)) {
			sessions.push({
				name,
				owner: companionPrefix + name.slice(legacyCompanionPrefix.length),
			});
		}
	}

	return sessions;
}

/** Every session on the inner socket, or null when tmux did not answer. */
export function liveInnerSessions(
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
): Set<string> | null {
	try {
		const result = runner(['list-sessions', '-F', '#{session_name}']);
		if (result.error || result.status !== 0) return null;
		return new Set(result.stdout.trim().split('\n').filter(Boolean));
	} catch {
		return null;
	}
}

/**
 * STA-1420 layer 2: reap this repo's sessions on the inner socket that no
 * protected space owns. They accumulate when Pappardelle is hard-quit
 * (SIGKILL, terminal close, Ctrl-C during a slow `pre_workspace_deinit`)
 * between unregistering and killing. Symmetric to
 * `cleanupOrphanedOuterSessions`.
 *
 * `owned` names the spaces whose sessions have an owner, main's included, and
 * their stored session names (`protectedSessionNames`). A session is kept
 * when the session that owns it is one of them; nothing is parsed back into a
 * key.
 *
 * `runner` is exposed for tests only; production uses the spawnSync default.
 */
export function cleanupOrphanedInnerSessions(
	owned: ProtectedSessions,
	repoName?: string,
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
	knownRepos: string[] = listKnownRepos(),
): number {
	try {
		const sessions = innerSpaceSessions(repoName, runner, knownRepos);
		if (!sessions) return 0;
		const kept = new Set([
			...owned.names,
			...[...owned.names].map(name => legacyAgentSession(name)),
		]);
		const orphans = sessions.filter(session => !kept.has(session.owner));

		let killed = 0;
		const reapedKeys = new Set<string>();
		const failedKeys = new Set<string>();
		for (const {name} of orphans) {
			const key = sessionSpace(name, runner);
			const k = runner(['kill-session', '-t', exactSessionTarget(name)]);
			if (!k.error && k.status === 0) {
				killed++;
				log.info(`Killed orphaned inner-socket session: ${name}`);
				if (key) reapedKeys.add(key);
			} else if (key) {
				failedKeys.add(key);
			}
		}

		// A stray session of a space that is still open is reaped, but the
		// status it reports is the space's own.
		for (const key of reapedKeys)
			if (!failedKeys.has(key) && !owned.keys.has(key))
				void programStatus().remove(key);
		return killed;
	} catch {
		return 0;
	}
}

/**
 * The space a session was started for, from the PAPPARDELLE_SPACE its
 * creator set on it, or null when it has none. An orphan's space may have no
 * stored identity left to name it.
 */
function sessionSpace(name: string, runner: OuterTmuxRunner): string | null {
	const result = runner([
		'show-environment',
		'-t',
		exactSessionTarget(name),
		'PAPPARDELLE_SPACE',
	]);
	if (result.error || result.status !== 0) return null;
	const match = /^PAPPARDELLE_SPACE=(.+)$/m.exec(result.stdout);
	return match?.[1]?.trim() || null;
}

const simulatorCleanup = new QaSimulatorCleanup(
	undefined,
	key => !registry().has(key),
);

export async function deleteQaSimulator(issueKey: string): Promise<boolean> {
	return simulatorCleanup.delete(issueKey);
}

/** Kill both inner sessions without changing the workspace registry. */
export async function killSpaceSessions(
	issueKey: string,
	options?: {
		run?: AsyncTmuxRunner;
	},
): Promise<boolean> {
	const lookup = spaceIdentities().get(issueKey);
	if (lookup.kind === 'unreadable') {
		log.warn(
			`Could not read the stored identity of ${issueKey}`,
			lookup.error instanceof Error ? lookup.error : undefined,
		);
		return false;
	}

	if (lookup.kind === 'unknown') {
		// Any sessions it has are owned by no stored space, so the reaper
		// removes them at the next start.
		log.warn(`${issueKey} has no stored session names; no sessions to end`);
		return true;
	}

	const sessions = sessionNamesOf(lookup.identity);
	// Keep the agent running until companion teardown succeeds. Reattaching
	// after a companion failure must not recreate Claude with --continue.
	const run = options?.run ?? runTmux;
	const {splits} = await listCompanion(sessions.companion, run);
	for (const split of splits)
		if (!(await innerKillSession(split.session, run))) return false;
	if (!(await innerKillSession(sessions.companion, options?.run))) return false;
	const killed = await innerKillSession(sessions.agent, options?.run);
	// Also address the legacy name: a space whose session hasn't been
	// migrated yet would otherwise survive its own teardown (innerKillSession
	// returns true for missing sessions, so the agent-name kill "succeeds").
	const legacyKilled = await innerKillSession(
		legacyAgentSession(sessions.agent),
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
		.flatMap(other => SESSION_KINDS.map(kind => `${kind}-${other}-`));
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
		const repo = repoName ?? getRepoName();
		const agentPrefix = sessionPrefix('agent', repo);
		const legacyPrefix = sessionPrefix('claude', repo);
		const siblingPrefixes = siblingRepoPrefixes(repo, knownRepos);

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
//
// The rounds go out in many small calls, not one. Claude Code reads a large
// chunk of input as a paste: C-k then becomes a newline before the prompt, and
// the prompt does not submit (STA-3087). 8 rounds in one write submitted and 16
// failed, so 4 rounds per call keeps a margin. Each call is a separate write,
// and the chunks stayed apart also while the agent streamed output.
export const CLEAR_COMPOSER_ROUNDS = 200;
export const CLEAR_COMPOSER_ROUNDS_PER_CALL = 4;
const clearChunk = (keys: readonly string[]) =>
	Array.from({length: CLEAR_COMPOSER_ROUNDS_PER_CALL}, () => keys).flat();
const CLEAR_COMPOSER_CHUNK = clearChunk(['C-e', 'C-k', 'C-u', 'BSpace']);
// Agy binds ctrl+k to approve inline subagent banners, so clearing an agy
// composer must never send C-k.
const CLEAR_AGY_COMPOSER_CHUNK = clearChunk(['C-e', 'C-u', 'BSpace']);
const CLEAR_COMPOSER_CALLS =
	CLEAR_COMPOSER_ROUNDS / CLEAR_COMPOSER_ROUNDS_PER_CALL;

/** An agent's tmux pane, and how a send waits between reads of it. */
type AgentPane = {
	runner: SendTmuxRunner;
	target: string;
	sleep: (ms: number) => Promise<void>;
};

/** Runs tmux calls in order and stops at the first that fails. */
async function runSteps(
	{runner}: AgentPane,
	steps: Array<{args: string[]; input?: string}>,
): Promise<boolean> {
	for (const {args, input} of steps) {
		const r = await runner(args, input);
		if (r.error || r.status !== 0) return false;
	}

	return true;
}

/**
 * Leave any pane mode, so a viewer scrolled back in copy-mode doesn't swallow
 * the Enter while the paste still reaches the agent, then empty the composer
 * when it may hold something. In Claude, the clear also leaves shell mode.
 */
async function prepareComposer(
	pane: AgentPane,
	{
		clear,
		agy = false,
		enterInsert = false,
	}: {clear: boolean; agy?: boolean; enterInsert?: boolean},
): Promise<boolean> {
	const {target} = pane;
	const clearChunk = agy ? CLEAR_AGY_COMPOSER_CHUNK : CLEAR_COMPOSER_CHUNK;
	return runSteps(pane, [
		{args: ['copy-mode', '-q', '-t', target]},
		...(clear
			? [
					...(enterInsert ? [{args: ['send-keys', '-t', target, 'i']}] : []),
					...Array.from({length: CLEAR_COMPOSER_CALLS}, () => ({
						args: ['send-keys', '-t', target, ...clearChunk],
					})),
				]
			: []),
	]);
}

/**
 * Agents detect a fast burst of keystrokes as a paste and turn an Enter that
 * arrives inside it into a newline: Codex does this even when Enter is its own
 * `send-keys` call, and drops the newlines of text typed key by key. A
 * bracketed paste marks where the text ends, so the Enter after it submits.
 * `-r` keeps newlines as LF, so an app without bracketed paste mode does not
 * receive each line as a separate submit. The text goes through stdin because
 * tmux rejects a command line over ~16KB.
 *
 * `-d` only deletes the buffer when the paste succeeds, so a failed paste
 * deletes it explicitly rather than leave the prompt on the server.
 */
async function pasteText(pane: AgentPane, text: string): Promise<boolean> {
	const {runner, target} = pane;
	const buffer = `pappardelle-send-${process.pid}`;
	if (
		!(await runSteps(pane, [
			{args: ['load-buffer', '-b', buffer, '-'], input: text},
		]))
	)
		return false;
	const r = await runner([
		'paste-buffer',
		'-p',
		'-d',
		'-r',
		'-b',
		buffer,
		'-t',
		target,
	]);
	if (r.error || r.status !== 0) {
		await runner(['delete-buffer', '-b', buffer]);
		return false;
	}

	return true;
}

async function pressEnter({runner, target}: AgentPane): Promise<boolean> {
	const r = await runner(['send-keys', '-t', target, 'Enter']);
	return !r.error && r.status === 0;
}

async function readAgentScreen({
	runner,
	target,
}: AgentPane): Promise<AgentScreen | null> {
	const r = await runner(['capture-pane', '-p', '-e', '-J', '-t', target]);
	if (r.error || r.status !== 0) return null;
	return parseAgentScreen(r.stdout, new Date());
}

// A send reads the agent's screen every 50 ms. A Codex session that has taken
// no prompt yet works through the clear keys at about 100 a second, 7.5-9 s
// for a forced send (pappardelle-hrdr), so up to 12 s for a box to read empty
// after them. For agy (AGY_CLEARED_POLLS, 2 s), if initial readline clear keys
// fail in vim normal mode, submit enters insert mode once and falls back to
// CLEARED_POLLS (12 s). A paste into an empty box showed within 100 ms; 3 s is
// margin. Then up to 2 s after each Enter for the text to leave. Even with the
// normal-mode fallback plus tmux calls between reads, a send's hold on the
// send lock stays under the 30 s after which another sender takes the lock over.
const SCREEN_POLL_MS = 50;
const CLEARED_POLLS = 240;
const AGY_CLEARED_POLLS = 40;
const PASTE_SHOWN_POLLS = 60;
const ENTER_TAKEN_POLLS = 40;
// The bead's report was that the key after a lost Enter submitted the text.
const ENTER_ATTEMPTS = 2;

/**
 * Read the agent's screen until `done` holds for it, at most `polls` times.
 * Counting reads rather than reading the clock keeps a test's instant sleep
 * from spinning.
 */
async function waitForScreen(
	pane: AgentPane,
	polls: number,
	done: (screen: AgentScreen) => boolean,
): Promise<AgentScreen | undefined> {
	for (let poll = 0; poll < polls; poll++) {
		if (poll > 0) await pane.sleep(SCREEN_POLL_MS);
		const screen = await readAgentScreen(pane);
		if (screen && done(screen)) return screen;
	}

	return undefined;
}

/**
 * Paste `text` and press Enter. When the agent's input box can be read, a box
 * that needed clearing must read empty, out of shell mode, before the paste;
 * the pasted text must show there, the same over two reads, before Enter is
 * pressed; and it must leave after. If it stays, Enter is pressed once more.
 *
 * Enter is pressed again only when the read just before it shows the pasted
 * text still in the box, so a dialog the submit opened has had to appear
 * within one tmux round trip to take that Enter.
 */
async function submit(
	pane: AgentPane,
	text: string,
	before: AgentScreen,
): Promise<'sent' | 'unsubmitted' | 'failed'> {
	const watched = before.composer !== null;
	const clear = before.composer !== '' || before.shellMode;
	const agy = Boolean(before.agyComposer);
	if (!(await prepareComposer(pane, {clear, agy}))) return 'failed';
	if (watched && clear) {
		const polls = agy ? AGY_CLEARED_POLLS : CLEARED_POLLS;
		let cleared = await waitForScreen(
			pane,
			polls,
			screen => screen.composer === '' && !screen.shellMode,
		);
		if (!cleared && agy) {
			// Agy's vim normal mode ignores readline clear keys without showing a
			// mode label, so only a draft that survived them gets `i` + re-clear.
			const current = await readAgentScreen(pane);
			if (current?.agyComposer && current.composer) {
				if (
					!(await prepareComposer(pane, {
						clear: true,
						agy: true,
						enterInsert: true,
					}))
				)
					return 'failed';
				cleared = await waitForScreen(
					pane,
					CLEARED_POLLS,
					screen => screen.composer === '' && !screen.shellMode,
				);
			}
		}

		if (!cleared) return 'failed';
	}

	if (!(await pasteText(pane, text))) return 'failed';
	if (!watched) return (await pressEnter(pane)) ? 'sent' : 'failed';
	// A long paste can be drawn over several reads.
	let previous: string | null = null;
	const shown = await waitForScreen(pane, PASTE_SHOWN_POLLS, ({composer}) => {
		const settled = Boolean(composer) && composer === previous;
		previous = composer;
		return settled;
	});
	// Unseen, the text may not be in the box at all, and Enter could land on
	// whatever took its place.
	if (!shown) return 'failed';
	for (let attempt = 0; attempt < ENTER_ATTEMPTS; attempt++) {
		if (!(await pressEnter(pane))) return 'failed';
		const taken = await waitForScreen(
			pane,
			ENTER_TAKEN_POLLS,
			({composer}) => composer !== shown.composer,
		);
		if (taken) return 'sent';
	}

	return 'unsubmitted';
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

/** `resolveInnerSessionTarget` for the CLI verbs, which run tmux synchronously. */
export function resolveInnerSessionTargetSync(
	sessionName: string,
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
): string | null {
	const result = runner(['list-sessions', '-F', '#{session_name}']);
	if (result.error || result.status !== 0) return null;
	const live = result.stdout.trim().split('\n');
	return live.includes(sessionName) ? exactSessionTarget(sessionName) : null;
}

export type SendToSpaceAgentResult =
	| 'sent'
	| 'draft'
	| 'prompt'
	| 'no-session'
	| 'busy'
	/** The text showed in the input box and was still there after two Enters. */
	| 'unsubmitted'
	| 'failed';

/**
 * Why the agent's screen stops a send. A permission prompt or question takes
 * the keys as an answer, which must go through `pappardelle answer` and its
 * policy. Text typed into the agent's input box would be cleared by the send.
 */
function sendBlocker(
	screen: AgentScreen,
	force: boolean,
): 'draft' | 'prompt' | null {
	if (
		screen.permission ||
		screen.question ||
		screen.codexDialog ||
		screen.agyDialog
	)
		return 'prompt';
	return screen.composer && !force ? 'draft' : null;
}

type SnapshotReader = (
	key: string,
	pane: StatusPane,
) => Promise<ProgramStatusSnapshot | null>;

/**
 * OSC fallback for prompts the screen parser didn't recognise: when the agent
 * reports OSC `blocked` (permission, question, auth), refuse sends and
 * non-Escape keys so an unparsed prompt is never answered by accident.
 * Agy's non-modal `Approve plan` artifact banner stays open to sends.
 */
async function isOscBlockedPrompt(
	issueKey: string,
	session: string,
	screen: AgentScreen,
	{
		runner,
		readSnapshot,
	}: {
		runner: SendTmuxRunner;
		readSnapshot?: SnapshotReader;
	},
): Promise<boolean> {
	const reader: SnapshotReader | null =
		readSnapshot ??
		(stateDaos
			? async (key: string, pane: StatusPane) => programStatus().read(key, pane)
			: null);
	if (!reader) return false;
	const listing = await runner([
		'list-panes',
		'-s',
		'-t',
		exactSessionTarget(session),
		'-F',
		AGENT_PANE_FORMAT,
	]);
	if (listing.error || listing.status !== 0) return false;
	const pane = statusPaneOf(
		listing.stdout.split('\n').filter(Boolean),
		statusSocket(),
	);
	if (!pane) return false;
	const snapshot = await reader(issueKey, pane);
	if (!snapshot?.authoritative) return false;
	const status = snapshot.info;
	if (status.status !== 'blocked') return false;
	// Agy modal prompts hide the `>` composer; an open composer without an inline
	// approval banner means OSC `blocked` is either the non-modal artifact strip
	// or has not cleared yet after a deny.
	if (screen.agyComposer && !screen.agyComposer.inlineApproval) return false;
	return true;
}

/**
 * Submit `text` as a prompt to the agent session of a space.
 * Backs `pappardelle send`, which the sous-chef skill relays through.
 */
export async function sendToSpaceAgent(
	issueKey: string,
	text: string,
	options: {
		runner?: SendTmuxRunner;
		lockDir?: string;
		lockTimeoutMs?: number;
		/** Send over a draft in the input box. Never over a prompt. */
		force?: boolean;
		sleep?: (ms: number) => Promise<void>;
		readSnapshot?: SnapshotReader;
	} = {},
): Promise<SendToSpaceAgentResult> {
	const runner = options.runner ?? defaultInnerSendRunner;
	const session = spaceSessionNames(issueKey)?.agent;
	if (!session) return 'no-session';
	const target = await resolveInnerSessionTarget(session, runner);
	if (!target) return 'no-session';
	try {
		return await withSendLock(
			session,
			async () => {
				// Checked under the lock, so no other send changes the screen
				// between the check and the paste.
				const pane = {runner, target, sleep: options.sleep ?? delay};
				const screen = await readAgentScreen(pane);
				// Unread, the screen may hold a prompt the keys would answer.
				if (!screen) return 'failed';
				const blocker = sendBlocker(screen, options.force ?? false);
				if (blocker === 'prompt') return 'prompt';
				if (
					await isOscBlockedPrompt(issueKey, session, screen, {
						runner,
						readSnapshot: options.readSnapshot,
					})
				)
					return 'prompt';
				if (blocker) return blocker;
				return submit(pane, text, screen);
			},
			{dir: options.lockDir, timeoutMs: options.lockTimeoutMs},
		);
	} catch (error) {
		if (error instanceof SendLockTimeout) return 'busy';
		log.error(`Send to ${session} failed`, error as Error);
		return 'failed';
	}
}

// Pause between an injected Escape and the key after it so agy's terminal
// parser finishes decoding bare Escape before reading the next sequence.
const AGY_KEY_SETTLE_MS = 80;

export function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Adapt supervisor key presses for agy's vim insert mode and announcement
 * banner. In vim insert mode a single Escape only leaves insert mode while a
 * turn keeps running, and Shift-Tab is ignored until insert mode and the
 * `esc to dismiss` banner are cleared (only while idle, so Shift-Tab never
 * cancels a running turn).
 */
function adaptAgySupervisorKeys(
	keys: readonly string[],
	agy: AgyComposerState,
): {keys: string[]; settleAfterEscape: boolean} {
	if (
		keys.length === 1 &&
		keys[0] === 'Escape' &&
		agy.vimInsert &&
		agy.working
	) {
		return {keys: ['Escape', 'Escape'], settleAfterEscape: true};
	}

	const normalized = keys.map(key => (key === 'S-Tab' ? 'BTab' : key));
	const firstShiftTab = normalized.indexOf('BTab');
	if (firstShiftTab === -1) return {keys: normalized, settleAfterEscape: false};

	let leadingEscapes = 0;
	for (let index = firstShiftTab - 1; index >= 0; index--) {
		if (normalized[index] === 'Escape') leadingEscapes++;
		else break;
	}

	const neededEscapes = agy.working
		? 0
		: (agy.vimInsert ? 1 : 0) + (agy.announcementBanner ? 1 : 0);
	const extraEscapes = Math.max(0, neededEscapes - leadingEscapes);
	return {
		keys: [
			...normalized.slice(0, firstShiftTab),
			...Array.from({length: extraEscapes}, () => 'Escape'),
			...normalized.slice(firstShiftTab),
		],
		settleAfterEscape: extraEscapes > 0 || leadingEscapes > 0,
	};
}

/**
 * Press tmux key names such as Escape or S-Tab in a space's agent session,
 * in order. Nothing is cleared or submitted around them, so a keybinding
 * reaches the TUI exactly as if the user pressed it.
 */
export async function sendKeysToSpaceAgent(
	issueKey: string,
	keys: readonly string[],
	options: {
		runner?: OuterTmuxRunner;
		/** Set by `pappardelle answer`, which has already checked the prompt. */
		answering?: boolean;
		/** Type each entry as text rather than as a key name such as Enter. */
		literal?: boolean;
		/** Override the pause between injected Escape keys in tests. */
		pause?: (ms: number) => void;
		readSnapshot?: SnapshotReader;
	} = {},
): Promise<SendToSpaceAgentResult> {
	const runner = options.runner ?? defaultInnerTmuxRunner;
	const session = spaceSessionNames(issueKey)?.agent;
	const target = session && resolveInnerSessionTargetSync(session, runner);
	if (!target) return 'no-session';
	let effectiveKeys: readonly string[] = keys;
	let settleAfterEscape = false;
	// A key such as 1 or Enter answers a prompt, which only `answer` may do
	// under its policy. Escape declines a Claude prompt, so it stays open to
	// anyone, but on a folder-trust dialog it can quit the agent.
	if (!options.answering) {
		const screen = runner(['capture-pane', '-p', '-e', '-J', '-t', target]);
		if (screen.error || screen.status !== 0) return 'failed';
		const parsed = parseAgentScreen(screen.stdout ?? '', new Date());
		if (parsed.codexDialog || parsed.agyDialog === 'trust') return 'prompt';
		const answers = keys.some(key => key !== 'Escape');
		if (
			answers &&
			(parsed.permission ||
				parsed.question ||
				parsed.agyDialog ||
				(await isOscBlockedPrompt(issueKey, session, parsed, {
					runner,
					readSnapshot: options.readSnapshot,
				})))
		)
			return 'prompt';
		if (!options.literal && parsed.agyComposer) {
			const adapted = adaptAgySupervisorKeys(keys, parsed.agyComposer);
			effectiveKeys = adapted.keys;
			settleAfterEscape = adapted.settleAfterEscape;
		}
	} else {
		settleAfterEscape = !options.literal;
	}

	const pause = options.pause ?? sleepSync;
	for (let index = 0; index < effectiveKeys.length; index++) {
		const key = effectiveKeys[index]!;
		const r = runner([
			'send-keys',
			...(options.literal ? ['-l'] : []),
			'-t',
			target,
			// Typed text can start with a dash.
			'--',
			key,
		]);
		if (r.error || r.status !== 0) return 'failed';
		if (
			settleAfterEscape &&
			key === 'Escape' &&
			index < effectiveKeys.length - 1
		) {
			pause(AGY_KEY_SETTLE_MS);
		}
	}

	return 'sent';
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
	layout: PaneLayout,
	run: AsyncTmuxRunner,
): Promise<WindowGeometry> {
	const geometry = parseWindowGeometry(
		await run(paneGeometryArgs(layout.listPaneId)),
	);
	recordGeometry(geometry, layout);
	return geometry;
}

// tmux rounds split sizes; sample the resulting window and side panes together
// so rounding or a concurrent window resize cannot masquerade as a hand-drag.
function recordGeometry(snapshot: WindowGeometry, layout: PaneLayout): void {
	lastWindowSize = snapshot.window;
	lastRailWidth = paneGeometry(snapshot, layout.listPaneId).cols;
	lastCompanionWidth = companionColumnWidth(snapshot, layout);
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
	return listOpenSpaces(registry()).length;
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
		getActiveSpaceCount(),
		getConfiguredListLines(),
		PINNED_LIST_ROWS,
	);
}

/**
 * Calculate pane layout based on terminal dimensions.
 * Reads space count from the persisted registry and reserves a line for the
 * pinned main-worktree row.
 */
export function calculateLayout(
	totalWidth: number,
	totalHeight: number,
): LayoutConfig {
	return calculateLayoutForSize(
		totalWidth,
		totalHeight,
		getActiveSpaceCount(),
		currentPaneWidths(),
		getConfiguredListLines(),
		PINNED_LIST_ROWS,
	);
}

/**
 * A dragged width replaces the configured one for that pane. Once either side
 * has been dragged, claude takes whatever is left, the same as under the mouse.
 */
function currentPaneWidths(): PaneWidths {
	const configured = getConfiguredPaneWidths();
	const dragged =
		railWidthOverride !== null ||
		companionWidthOverride !== null ||
		spaceCompanionWidth !== null;
	return {
		rail: railWidthOverride ?? configured.rail,
		companion:
			spaceCompanionWidth?.width ??
			companionWidthOverride ??
			configured.companion,
		claude: dragged ? null : configured.claude,
	};
}

/**
 * Set up the pane layout for pappardelle
 * Returns pane IDs for [list, agentViewer, companionViewer]
 *
 * Layout depends on screen width:
 * - Narrow screens (< 90 chars): Vertical layout [list on top] [agent below], no companion
 * - Wide screens (>= 90 chars): Horizontal layout [list] [claude] [companion]
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
			tmuxFormatLiteral(cwd),
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
			const snapshot = parseWindowGeometry(geometry);
			recordGeometry(snapshot, {
				listPaneId,
				agentViewerPaneId,
				companionViewerPaneId,
			});
			await setInnerDefaultSize(snapshot, agentViewerPaneId, runTmux);
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
//
// It goes over the control client: tmux 3.4 crashes when a command from
// another client notifies a control client that is still being set up, and
// the layout's splits are sent while the control client starts.
async function runSetup(
	args: string[],
): Promise<{ok: boolean; stdout: string; stderr: string}> {
	try {
		return {ok: true, stdout: await runTmux(args), stderr: ''};
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
		: spaceState().read(issueKey)?.profile;
}

/**
 * The agent profile running in a space: the one its agent session was last
 * started with, which covers a one-launch picker override, else the one its
 * profile selects. A stored name the config no longer defines falls back too.
 */
export function runningAgentProfile(
	config: PappardelleConfig,
	issueKey: string,
	issueTitle?: string,
): ResolvedAgentProfile {
	return getSpaceAgentProfile(config, issueKey, {
		agentProfile: spaceState().read(issueKey)?.agentProfile,
		issueTitle,
		profile: savedSpaceProfile(issueKey),
	});
}

/**
 * The name the agent viewer's frame gives a space's agent. Without a config
 * the built-in claude profile runs; an invalid one holds the agent back.
 */
export function spaceAgentName(
	load: ConfigLoad,
	issueKey: string,
	issueTitle?: string,
): string {
	switch (load.kind) {
		case 'valid': {
			return agentDisplayName(
				runningAgentProfile(load.config, issueKey, issueTitle),
			);
		}

		case 'missing': {
			return agentDisplayName(DEFAULT_RESOLVED_AGENT_PROFILE);
		}

		case 'invalid': {
			return AGENT_NAME_FALLBACK;
		}
	}
}

/**
 * Agents launched before spaces stored the agent profile they started with
 * told their hook in the session env instead, so their hook records nothing
 * until it is stored. The agent that started last is the one running. A space
 * whose agent never recorded an id stays unknown until it relaunches.
 */
export async function storeLaunchedAgentProfiles(
	config: PappardelleConfig,
	sessions: Pick<AgentSessionsDao, 'keys' | 'latestProfile'>,
	states: Pick<SpaceStateDao, 'read' | 'write'>,
): Promise<void> {
	for (const key of sessions.keys()) {
		if (states.read(key)?.agentProfile) continue;
		const name = sessions.latestProfile(key);
		if (!name || checkAgentProfile(config, name).kind !== 'known') continue;
		const {isClaude} = getNamedAgentProfile(config, name);
		await states.write(key, {agentProfile: {name, isClaude}});
	}
}

type AttachOptions = {
	signal?: AbortSignal;
	run?: AsyncTmuxRunner;
	/** Titles the agent frame in place of the key. */
	label?: string;
	/** The config the caller loaded, which names the agent on a fast switch. */
	configLoad: ConfigLoad;
};

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
		listPaneId: string | undefined,
		mainWorktreePath: string | undefined,
		issueTitle: string | undefined,
		options: AttachOptions,
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

// Fast switches read no config of their own. The TUI hands over the one it
// started with, so a newer one a slow attach read wins.
let latestConfigLoad: ConfigLoad | undefined;

async function attachViewers(
	agentViewerPaneId: string,
	companionViewerPaneId: string,
	issueKey: string,
	listPaneId: string | undefined,
	mainWorktreePath: string | undefined,
	issueTitle: string | undefined,
	options: AttachOptions,
): Promise<boolean> {
	const traceDone = startupTrace.current?.begin('attachment');
	const {signal} = options;
	const name = options.label ?? issueKey;
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
	const sessions = spaceSessionNames(issueKey);
	if (!sessions) {
		traceDone?.('failed');
		return false;
	}

	let configuredSplits: ResolvedCompanionSplit[] | undefined;
	// A split that fails to show leaves the agent and companion attached.
	// `listing` is the session listing the attach asked for along with its own
	// commands, which saves this a tmux call of its own.
	const syncSplitsAfterAttach = async (listing?: string): Promise<boolean> => {
		try {
			await syncCompanionSplits(
				{agentViewerPaneId, companionViewerPaneId},
				issueKey,
				{
					// Not cut short by a newer selection: half-made split panes would
					// stay on screen. The next attach's sync waits for this one.
					run: options.run ?? runTmux,
					listing,
					seed() {
						if (configuredSplits) return configuredSplits;
						const load = readConfig();
						// Without a config there are no splits to seed, and an
						// invalid one is seeded once it is fixed.
						return load.kind === 'valid'
							? getCompanionSplits(
									load.config,
									issueTitle,
									savedSpaceProfile(issueKey),
								)
							: undefined;
					},
				},
			);
		} catch (err) {
			if (signal?.aborted) return false;
			log.warn(
				`Failed to show the companion splits of ${issueKey}`,
				err instanceof Error ? err : undefined,
			);
		}

		return true;
	};
	if (
		agentViewerHasClient &&
		agentViewerTty &&
		(!companionViewerPaneId || (companionViewerHasClient && companionViewerTty))
	) {
		const fastAgentTitle = agentFrameTitle(
			spaceAgentName(
				latestConfigLoad ?? options.configLoad,
				issueKey,
				issueTitle,
			),
			name,
		);
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
			commands.push(';', ...viewerSessionArgs(sessions.agent, fastAgentTitle));
			if (companionViewerPaneId)
				commands.push(
					';',
					...viewerSessionArgs(sessions.companion, COMPANION_FRAME_TITLE),
				);
			commands.push(';', ...SPLIT_LIST_ARGS);
			// Existing clients can switch directly. tmux validates both targets;
			// an exited client or missing session falls back to setup below.
			const listing = await run(innerTmuxArgs(commands));
			await run(
				agentTitleAndFocusArgs(agentViewerPaneId, fastAgentTitle, listPaneId),
			);
			currentlyViewingSpace = issueKey;
			const shown = await syncSplitsAfterAttach(listing);
			traceDone?.(shown ? undefined : 'cancelled');
			return shown;
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
	let launch: AgentLaunch = {rules: false};
	let splitListing: string | undefined;
	const profileName = savedSpaceProfile(issueKey);
	// Without a config there is no agent profile to lose, so the built-in one
	// is right. A broken config would replace the space's own.
	const load = readReportedConfig();
	latestConfigLoad = load;
	const invalidConfig = load.kind === 'invalid';
	if (load.kind === 'valid') {
		const {config} = load;
		skipPermissions = getDangerouslySkipPermissions(config);
		companionCommand = getCompanionCommand(config, issueTitle, profileName);
		configuredSplits = getCompanionSplits(config, issueTitle, profileName);
		agentProfile = getNamedAgentProfile(
			config,
			spaceAgentProfileName(config, issueKey, issueTitle, profileName),
			issueTitle,
			profileName,
		);
		launch = {
			rules: workspaceAwareAgents(config),
			...(issueKey === MAIN_WORKTREE_KEY
				? sousChefLaunch(config, agentProfile)
				: {}),
		};
	}

	if (agentProfile)
		sessionId = agentSessions().read(issueKey, agentProfile.name);

	try {
		// Complete session creation and command launch together so a superseded
		// selection can't leave an existing session with no agent running.
		// A broken config would start the space's programs with the wrong
		// commands, and they keep running after the config is fixed.
		const prepared = await Promise.allSettled([
			invalidConfig
				? resumeHeldBackAgent(issueKey, sessions.agent, options.run ?? runTmux)
				: ensureAgentSession(
						issueKey,
						mainWorktreePath,
						skipPermissions,
						options.run ?? runTmux,
						agentProfile,
						sessionId,
						launch,
					),
			companionViewerPaneId
				? invalidConfig
					? resumeHeldBackCompanion(
							issueKey,
							sessions.companion,
							options.run ?? runTmux,
						)
					: ensureCompanionSession(
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
		// After the launch, which records the profile it started.
		const agentTitle = agentFrameTitle(
			spaceAgentName(load, issueKey, issueTitle),
			name,
		);

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
					? [viewerSessionArgs(sessions.agent, agentTitle)]
					: []),
				...(hasCompanionSession
					? [viewerSessionArgs(sessions.companion, COMPANION_FRAME_TITLE)]
					: []),
			];
			// Listed with the setup only when there is a session, and so a server.
			if (sessionSetup.length > 0)
				splitListing = await run(
					innerTmuxArgs(
						[...sessionSetup, SPLIT_LIST_ARGS].flatMap((args, index) =>
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
					? nestedAttachCommand(session)
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
					agentTitle,
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
				agentTitleAndFocusArgs(agentViewerPaneId, agentTitle, listPaneId),
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
		const shown = await syncSplitsAfterAttach(splitListing);
		traceDone?.(shown ? undefined : 'cancelled');
		return shown;
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

// ============================================================================
// Companion splits in the outer window
// ============================================================================

/**
 * A companion split the TUI shows in an outer pane of its own, with its own
 * frame. Only the space on screen has these panes; switching to a space whose
 * splits are arranged the same way moves their clients instead.
 */
type ShownSplit = {
	name: string;
	session: string;
	split: SplitDirection;
	paneId: string;
	tty: string;
	/** Its size along its axis when the TUI last moved the panes. */
	size: number | null;
	/** Its stored size when the TUI last showed it, to tell a new one apart. */
	stored: PaneWidth | null;
};

const shownSplits: ShownSplit[] = [];
let shownSplitSignature: string | null = null;
/** The space whose splits are shown. */
let shownSplitsSpace: string | null = null;
let splitSizesWindow: WindowSize | null = null;
let splitSizesColumn: number | null = null;
let splitSyncPending = false;

export function companionSplitPaneIds(): string[] {
	return shownSplits.map(split => split.paneId);
}

/** True once after a sync was put off because a dialog had the rail zoomed. */
export function takePendingSplitSync(): boolean {
	const pending = splitSyncPending;
	splitSyncPending = false;
	return pending;
}

/**
 * The companion column is everything right of the agent pane, so a split
 * beside main counts toward `companion width` as main does.
 */
function companionColumnWidth(
	geometry: WindowGeometry,
	layout: Pick<PaneLayout, 'agentViewerPaneId' | 'companionViewerPaneId'>,
): number | null {
	// The companion pane closes when the shell left in it exits.
	if (!geometry.panes.has(layout.companionViewerPaneId)) return null;
	const agent = geometry.panes.get(layout.agentViewerPaneId);
	return agent ? geometry.window.width - agent.right - 2 : null;
}

export async function measureCompanionColumnWidth(
	layout: Pick<PaneLayout, 'agentViewerPaneId' | 'companionViewerPaneId'>,
	run: AsyncTmuxRunner = runTmux,
): Promise<number | null> {
	if (!layout.companionViewerPaneId) return null;
	return companionColumnWidth(
		parseWindowGeometry(
			await run(paneGeometryArgs(layout.companionViewerPaneId)),
		),
		layout,
	);
}

function alongSplit(pane: PaneGeometry, split: SplitDirection): number {
	return split === 'right' ? pane.cols : pane.rows;
}

/**
 * A split whose size changed while the window's didn't had its border moved
 * by hand. The size is kept on its session, in cells, so the split opens at
 * it next time, and in `splits`, the listing this sync lays out.
 */
async function rememberSplitDrags(
	measured: WindowGeometry,
	column: number | null,
	splits: CompanionSplit[],
	run: AsyncTmuxRunner,
): Promise<void> {
	// A split that closed gave its cells to a neighbour; that's no drag.
	if (shownSplits.some(split => !measured.panes.has(split.paneId))) return;
	for (const split of shownSplits) {
		// A new column width moves every split beside main with it; that is
		// `companion width` or the agent pane's border, not this split's.
		if (split.split === 'right' && column !== splitSizesColumn) continue;
		const listed = splits.find(each => each.session === split.session);
		// A size set since it was shown (companion resize) wins over a drag.
		if (listed && listed.size !== split.stored) continue;
		const pane = measured.panes.get(split.paneId)!;
		const dragged = nextSizeOverride({
			previousWindow: splitSizesWindow,
			currentWindow: measured.window,
			previousSize: split.size,
			currentSize: alongSplit(pane, split.split),
			currentOverride: null,
		});
		if (dragged === null) continue;
		split.size = dragged;
		split.stored = dragged;
		if (listed) listed.size = dragged;
		log.info(`Companion split ${split.session} resized by hand: ${dragged}`);
		try {
			await run(innerTmuxArgs(splitOptionArgs(split.session, 'size', dragged)));
		} catch (err) {
			log.warn(
				`Failed to keep the size of ${split.session}`,
				err instanceof Error ? err : undefined,
			);
		}
	}
}

function recordSplitSizes(
	measured: WindowGeometry,
	column: number | null,
): void {
	splitSizesWindow = measured.window;
	splitSizesColumn = column;
	for (const split of shownSplits) {
		const pane = measured.panes.get(split.paneId);
		split.size = pane ? alongSplit(pane, split.split) : null;
	}
}

/** Keep a drag of a shown split's border before the panes move. */
async function keepSplitDrags(
	layout: PaneLayout,
	run: AsyncTmuxRunner,
	snapshot?: WindowGeometry,
): Promise<void> {
	if (shownSplits.length === 0 || !shownSplitsSpace) return;
	const measured =
		snapshot ??
		parseWindowGeometry(await run(paneGeometryArgs(layout.listPaneId)));
	const companion = spaceSessionNames(shownSplitsSpace)?.companion;
	if (!companion) return;
	const {splits} = await listCompanion(companion, run);
	await rememberSplitDrags(
		measured,
		companionColumnWidth(measured, layout),
		splits,
		run,
	);
}

/**
 * Close the split panes, as before showing others or when the space on
 * screen is closed. One call per pane: tmux skips the rest of a command list
 * after a failure.
 */
export async function closeCompanionSplitPanes(
	run: AsyncTmuxRunner = runTmux,
): Promise<void> {
	shownSplitSignature = null;
	while (shownSplits.length > 0) {
		await killPane(shownSplits[0]!.paneId, run);
		shownSplits.shift();
	}
}

const SPLIT_LIST_ARGS = ['list-sessions', '-F', SPLIT_LIST_FORMAT];

async function listCompanionSessions(run: AsyncTmuxRunner): Promise<string> {
	try {
		return await run(innerTmuxArgs(SPLIT_LIST_ARGS));
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') throw err;
		return '';
	}
}

async function listCompanion(
	companionSession: string,
	run: AsyncTmuxRunner,
): Promise<CompanionListing> {
	return parseCompanionListing(
		await listCompanionSessions(run),
		companionSession,
	);
}

/**
 * Start the configured splits once per companion session, so a split the
 * user closes stays closed. They're ordered as listed. One that fails to
 * start is tried again at the next attach. Returns whether it started any.
 */
async function seedCompanionSplits(
	identity: SpaceIdentity,
	splits: CompanionSplit[],
	configured: ResolvedCompanionSplit[],
	run: AsyncTmuxRunner,
): Promise<boolean> {
	const order = Date.now();
	let failed = false;
	let started = false;
	for (const [index, split] of configured.entries()) {
		if (splits.some(existing => existing.name === split.name)) continue;
		const result = createCompanionSplit(identity, {
			...split,
			order: order + index,
		});
		if (result.ok) {
			started = true;
		} else {
			failed = true;
			log.warn(
				`Failed to start companion split ${split.name} for ${identity.key}: ${result.reason}`,
			);
		}
	}

	if (!failed) {
		await run(
			innerTmuxArgs(
				splitOptionArgs(identity.tmux.companionSession, 'seeded', 1),
			),
		);
	}

	return started;
}

export type SplitSyncOutcome = 'applied' | 'deferred' | 'no-pane';

/**
 * Show the space's companion splits in framed outer panes split off the
 * companion pane. Runs inside the attachment queue, so two syncs never both
 * decide to split.
 *
 * Splitting or killing a pane unzooms the window, so while a dialog has the
 * rail zoomed this only notes that a sync is owed (`takePendingSplitSync`).
 */
export async function syncCompanionSplits(
	layout: Pick<PaneLayout, 'agentViewerPaneId' | 'companionViewerPaneId'>,
	issueKey: string,
	options: {
		run?: AsyncTmuxRunner;
		/** The splits to start with, or undefined to leave the companion unseeded for now. */
		seed?: () => ResolvedCompanionSplit[] | undefined;
		/** The inner sessions in SPLIT_LIST_FORMAT, when the caller just listed them. */
		listing?: string;
	} = {},
): Promise<SplitSyncOutcome> {
	const run = options.run ?? runTmux;
	const identity = storedIdentity(issueKey);
	if (!identity) return 'no-pane';
	const {companionSession} = identity.tmux;
	const listing = parseCompanionListing(
		options.listing ?? (await listCompanionSessions(run)),
		companionSession,
	);
	let {splits} = listing;
	const seed =
		listing.companion && !listing.companion.seeded
			? options.seed?.()
			: undefined;
	if (seed && (await seedCompanionSplits(identity, splits, seed, run)))
		({splits} = await listCompanion(companionSession, run));

	// rebuildLayout takes the split panes down with the companion pane.
	if (!layout.companionViewerPaneId && shownSplits.length === 0)
		return 'no-pane';
	if (splits.length === 0 && shownSplits.length === 0) return 'applied';

	const measure = async () =>
		parseWindowGeometry(await run(paneGeometryArgs(layout.agentViewerPaneId)));
	let measured = await measure();
	if (measured.window.zoomed) {
		splitSyncPending = true;
		return 'deferred';
	}

	// The companion pane closes when the shell left in it exits. Splits left
	// beside it would go on showing the space they were made for.
	if (!measured.panes.has(layout.companionViewerPaneId)) {
		await closeCompanionSplitPanes(run);
		return 'no-pane';
	}

	let column = companionColumnWidth(measured, layout);
	await rememberSplitDrags(measured, column, splits, run);
	const targets = splitTargets(splits, {
		width: column ?? 0,
		height: measured.window.height,
	});
	const fit = (panes: WindowGeometry) =>
		shownSplits.every((split, index) => {
			const pane = panes.panes.get(split.paneId);
			return pane && alongSplit(pane, split.split) === targets[index];
		});
	const sameShape =
		splitSignature(splits) === shownSplitSignature &&
		shownSplits.every(split => split.tty && measured.panes.has(split.paneId));
	// tmux takes a resized pane's cells from whichever neighbour it picks, not
	// always from main. When the panes don't come out at their sizes, they
	// are made again at those sizes.
	if (sameShape && !fit(measured)) {
		await resizeSplitPanes(targets, run);
		measured = await measure();
	}

	const reuse =
		sameShape && fit(measured) && (await switchSplitClients(splits, run));
	if (!reuse) {
		await closeCompanionSplitPanes(run);
		await showSplits(layout.companionViewerPaneId, splits, targets, run);
		shownSplitSignature = splitSignature(splits);
	}

	shownSplitsSpace = issueKey;
	measured = await measure();
	column = companionColumnWidth(measured, layout);
	recordSplitSizes(measured, column);
	return 'applied';
}

async function resizeSplitPanes(
	targets: number[],
	run: AsyncTmuxRunner,
): Promise<void> {
	for (const [index, split] of shownSplits.entries()) {
		await runLayoutCommand(
			[
				'resize-pane',
				'-t',
				split.paneId,
				split.split === 'right' ? '-x' : '-y',
				String(targets[index]),
			],
			run,
		);
	}
}

// Each split's client moves on its own call, after the agent and main ones,
// so a split whose client is gone rebuilds only the split panes.
async function switchSplitClients(
	splits: CompanionSplit[],
	run: AsyncTmuxRunner,
): Promise<boolean> {
	const commands: string[] = [];
	for (const [index, split] of splits.entries()) {
		const shown = shownSplits[index]!;
		if (commands.length > 0) commands.push(';');
		commands.push(
			'switch-client',
			'-c',
			shown.tty,
			'-t',
			exactSessionTarget(split.session),
			';',
			...viewerSessionArgs(split.session, split.name),
		);
		shown.session = split.session;
		shown.stored = split.size;
	}

	try {
		await run(innerTmuxArgs(commands));
		return true;
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') throw err;
		log.debug('Companion split clients could not switch; reopening the panes');
		return false;
	}
}

async function showSplits(
	companionViewerPaneId: string,
	splits: CompanionSplit[],
	targets: number[],
	run: AsyncTmuxRunner,
): Promise<void> {
	if (splits.length === 0) return;
	// Features apply when a client attaches, so before the panes start.
	await run(
		innerTmuxArgs([
			...frameTerminalFeaturesArgs(),
			';',
			...FRAME_ESCAPE_TIME_ARGS,
		]),
	);
	// Each split comes off the companion pane in the order it was made, which
	// rebuilds the arrangement the splits were asked for.
	for (const [index, split] of splits.entries()) {
		await run(innerTmuxArgs(viewerSessionArgs(split.session, split.name)));
		const output = await run([
			'split-window',
			'-d',
			split.split === 'right' ? '-h' : '-v',
			'-l',
			String(targets[index]),
			'-t',
			companionViewerPaneId,
			'-P',
			'-F',
			'#{pane_id}',
			frameHostCommand(nestedAttachCommand(split.session), split.name, 'close'),
		]);
		const paneId = output.trim();
		shownSplits.push({
			name: split.name,
			session: split.session,
			split: split.split,
			paneId,
			tty: '',
			size: null,
			stored: split.size,
		});
	}

	// The tty waits overlap, so several splits open as fast as one.
	await Promise.all(
		shownSplits.map(async split => {
			split.tty = await awaitViewerClientTty(split.paneId, run);
		}),
	);
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
		const before =
			snapshot ?? parseWindowGeometry(await run(paneGeometryArgs(listPaneId)));
		const windowDims = before.window;

		await keepSplitDrags(
			{
				listPaneId,
				agentViewerPaneId: oldAgentViewerPaneId,
				companionViewerPaneId: oldCompanionViewerPaneId,
			},
			run,
			before,
		);
		await closeCompanionSplitPanes(run);
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
					tmuxFormatLiteral(cwd),
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
					tmuxFormatLiteral(cwd),
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
						tmuxFormatLiteral(cwd),
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

		const layoutPanes = {listPaneId, agentViewerPaneId, companionViewerPaneId};
		return {
			layout: layoutPanes,
			geometry: await recordPaneSampleAsync(layoutPanes, run),
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
	layout: PaneLayout,
	run: AsyncTmuxRunner,
	geometry: WindowGeometry,
	spaceWidth: typeof spaceCompanionWidth,
): Promise<WindowGeometry | null> {
	const {listPaneId, agentViewerPaneId} = layout;
	try {
		const windowDims = geometry.window;

		const {width: totalWidth, height: totalHeight} = windowDims;

		await keepSplitDrags(layout, run, geometry);

		// Separate a window resize from a hand-drag of a side-pane border
		// *before* computing the layout, so a drag feeds its own width back in
		// instead of being recomputed away. See pane-drag.ts and STA-2040.
		const measuredRail = paneGeometry(geometry, listPaneId);
		let resizeAttempted = false;
		const measuredRailWidth = measuredRail.cols;
		const measuredCompanionWidth = companionColumnWidth(geometry, layout);
		const previousRail = railWidthOverride;
		const previousCompanion = companionWidthOverride;
		railWidthOverride = nextSizeOverride({
			previousWindow: lastWindowSize,
			currentWindow: windowDims,
			previousSize: lastRailWidth,
			currentSize: measuredRailWidth,
			currentOverride: railWidthOverride,
		});
		const companionDrag = nextSizeOverride({
			previousWindow: lastWindowSize,
			currentWindow: windowDims,
			previousSize: lastCompanionWidth,
			currentSize: measuredCompanionWidth,
			currentOverride: null,
		});
		if (companionDrag !== null && spaceWidth) {
			if (spaceCompanionWidth?.key === spaceWidth.key)
				spaceCompanionWidth = {key: spaceWidth.key, width: companionDrag};
			log.info(
				`Companion resized by hand for ${spaceWidth.key}: width=${companionDrag} (was ${String(spaceWidth.width)})`,
			);
			onSpaceCompanionDrag?.(spaceWidth.key, companionDrag);
		} else if (companionDrag !== null) {
			companionWidthOverride = companionDrag;
		}
		// A configured claude width can be what sized the other side pane, and
		// that width is dropped once anything is dragged or a space sets its own
		// companion width. Pinning the other side keeps it where it was instead
		// of jumping to its derived width.
		if (getConfiguredPaneWidths().claude !== undefined) {
			if (railWidthOverride !== previousRail)
				companionWidthOverride ??= measuredCompanionWidth;
			if (companionWidthOverride !== previousCompanion || spaceWidth)
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

		const sizes = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Relayout: ${totalWidth}x${totalHeight}, mode=${sizes.direction}` +
				(railWidthOverride === null ? '' : `, rail=${railWidthOverride}`) +
				(companionWidthOverride === null
					? ''
					: `, companion=${companionWidthOverride}`),
		);

		if (sizes.direction === 'vertical') {
			// Vertical: resize list pane height, claude gets remainder
			if (
				sizes.listHeight !== undefined &&
				sizes.listHeight !== measuredRail.rows
			) {
				resizeAttempted = true;
				const result = await runLayoutCommand(
					['resize-pane', '-t', listPaneId, '-y', String(sizes.listHeight)],
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
				sizes.listWidth !== undefined && sizes.listWidth !== measuredRailWidth;
			if (resizeRail) {
				resizeAttempted = true;
				const result = await runLayoutCommand(
					['resize-pane', '-t', listPaneId, '-x', String(sizes.listWidth)],
					run,
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize list pane width: ${result.stderr}`);
					return null;
				}
			}

			// The agent pane is sized, not the companion: the companion column
			// may hold splits beside main, and it takes what the agent leaves.
			if (
				measuredCompanionWidth !== null &&
				sizes.agentWidth !== undefined &&
				(resizeRail ||
					sizes.agentWidth !== paneGeometry(geometry, agentViewerPaneId).cols)
			) {
				resizeAttempted = true;
				const result = await runLayoutCommand(
					[
						'resize-pane',
						'-t',
						agentViewerPaneId,
						'-x',
						String(sizes.agentWidth),
					],
					run,
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize the agent pane width: ${result.stderr}`);
					// Non-fatal, continue
				}
			}
		}

		const measured = resizeAttempted
			? await recordPaneSampleAsync(layout, run)
			: geometry;
		if (!resizeAttempted) recordGeometry(measured, layout);

		// A new window or column size gives the splits new sizes to keep.
		if (shownSplits.length > 0 && shownSplitsSpace)
			await syncCompanionSplits(layout, shownSplitsSpace, {run});

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
): Promise<{
	layout: PaneLayout;
	dimensions: {rows: number; cols: number};
	/** The narrow layout: rail across the top, agent below, no companion. */
	stacked: boolean;
}> {
	// Captured before any await: the selection can change while this waits on
	// tmux, and a drag belongs to the space that was showing.
	const spaceWidth = spaceCompanionWidth;
	let geometry = parseWindowGeometry(
		await run(paneGeometryArgs(layout.listPaneId)),
	);
	if (geometry.window.zoomed !== zoomed) {
		await run(['resize-pane', '-Z', '-t', layout.listPaneId]);
		geometry = parseWindowGeometry(
			await run(paneGeometryArgs(layout.listPaneId)),
		);
	}
	const stacked = geometry.window.width < NARROW_SCREEN_THRESHOLD;
	if (!zoomed) {
		const vertical =
			paneGeometry(geometry, layout.listPaneId).cols === geometry.window.width;
		if (vertical !== stacked) {
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
				layout,
				run,
				geometry,
				spaceWidth,
			);
			if (!measured) throw new Error('Failed to resize pane layout');
			geometry = measured;
		}

		await setInnerDefaultSize(geometry, layout.agentViewerPaneId, run);
	}
	const {cols, rows} = paneGeometry(geometry, layout.listPaneId);
	return {layout, dimensions: {cols, rows}, stacked};
}

function existingDirectory(identity: SpaceIdentity): string | null {
	try {
		return statSync(identity.worktreePath).isDirectory()
			? identity.worktreePath
			: null;
	} catch {
		return null;
	}
}

/** A space's stored worktree, or null when it has none or it is gone. */
export function getWorktreePath(issueKey: string): string | null {
	const identity = storedIdentity(issueKey);
	return identity && existingDirectory(identity);
}

/** `getWorktreePath` off the event loop. */
export async function getWorktreePathAsync(
	issueKey: string,
): Promise<string | null> {
	const identity = storedIdentity(issueKey);
	if (!identity) return null;
	try {
		const stats = await stat(identity.worktreePath);
		return stats.isDirectory() ? identity.worktreePath : null;
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
		const {stdout} = await execFileAsync(
			'git',
			['worktree', 'list', '--porcelain'],
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);

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
 * Pre-trust a directory for Antigravity CLI (agy) by adding it to
 * `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`.
 * Never overwrites an existing file whose JSON cannot be parsed.
 */
export function pretrustDirectoryForAgy(
	worktreePath: string,
	settingsPath?: string,
): void {
	const resolvedSettingsPath =
		settingsPath ??
		process.env['PAPPARDELLE_AGY_SETTINGS_PATH'] ??
		join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
	try {
		let targetPath = resolvedSettingsPath;
		let fileMode = 0o600;
		let raw: string | undefined;
		try {
			targetPath = realpathSync(resolvedSettingsPath);
			fileMode = statSync(targetPath).mode % 0o1000;
			raw = readFileSync(targetPath, 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				log.warn(
					`Failed to read agy settings (${resolvedSettingsPath})`,
					err instanceof Error ? err : undefined,
				);
				return;
			}
		}

		let settings: Record<string, unknown> = {};
		if (raw !== undefined) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (err) {
				log.warn(
					`Refusing to overwrite invalid JSON in agy settings (${targetPath})`,
					err instanceof Error ? err : undefined,
				);
				return;
			}

			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				log.warn(
					`Refusing to overwrite non-object agy settings (${targetPath})`,
				);
				return;
			}

			settings = parsed as Record<string, unknown>;
		}

		const existing = settings['trustedWorkspaces'] ?? [];
		if (!Array.isArray(existing)) {
			log.warn(
				`Refusing to overwrite non-array trustedWorkspaces in agy settings (${targetPath})`,
			);
			return;
		}

		if (existing.includes(worktreePath)) return;

		settings['trustedWorkspaces'] = [...existing, worktreePath];
		mkdirSync(dirname(targetPath), {recursive: true});
		const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
		try {
			writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', {
				encoding: 'utf-8',
				mode: fileMode,
			});
			chmodSync(tmpPath, fileMode);
			renameSync(tmpPath, targetPath);
			log.info(`Pre-trusted directory for agy: ${worktreePath}`);
		} catch (err) {
			try {
				rmSync(tmpPath, {force: true});
			} catch {}

			throw err;
		}
	} catch (err) {
		log.warn(
			`Failed to pre-trust directory for agy: ${worktreePath}`,
			err instanceof Error ? err : undefined,
		);
	}
}

/**
 * The session environment for a space the TUI makes itself. A failure to find
 * the main checkout must not stop the session: the hook can still work it out.
 */
function spaceSessionEnvArgs(
	issueKey: string,
	repoName = getRepoName(),
): string[] {
	let mainRepoRoot: string | undefined;
	try {
		mainRepoRoot = getMainRepoRoot();
	} catch {
		// Leave it unset
	}

	return buildSessionEnvArgs(issueKey, repoName, mainRepoRoot);
}

const STARTUP_GATE_OPTION = '@pappardelle_startup_gate';

// The inner server loads the user's tmux.conf. With destroy-unattached on,
// tmux destroys every session no client is viewing, which is every background
// agent. With exit-unattached on, the server exits once no client is attached,
// taking the agents with it when the TUI quits. With exit-empty on (tmux's
// default), the server exits when the last space closes, and a space started
// while it is on its way out fails with "server exited unexpectedly".
const INNER_SERVER_KEEP_ALIVE_ARGS = [
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
	';',
	'set-option',
	'-s',
	'exit-empty',
	'off',
];

// A space's sessions are only ever seen nested in a viewer pane, where the
// user's own status bar would add a row naming the session under the rail's
// own header.
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
		const pane = await programStatus().attach(
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

/** Picks up an agent session that is already on the inner socket. */
async function resumeAgentSession(
	issueKey: string,
	sessionName: string,
	run: AsyncTmuxRunner,
): Promise<'resumed' | 'failed' | 'absent'> {
	if (!(await innerSessionExistsAsync(sessionName, run))) return 'absent';
	try {
		await attachStartupMonitor(issueKey, sessionName, run);
		await releaseStartupGate(sessionName, run);
		return 'resumed';
	} catch (err) {
		log.error(
			`Failed to resume agent startup for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return 'failed';
	}
}

async function resumeHeldBackAgent(
	issueKey: string,
	sessionName: string,
	run: AsyncTmuxRunner,
): Promise<boolean> {
	const resumed = await resumeAgentSession(issueKey, sessionName, run);
	if (resumed === 'absent') reportHeldBack(issueKey);
	return resumed === 'resumed';
}

async function resumeHeldBackCompanion(
	issueKey: string,
	sessionName: string,
	run: AsyncTmuxRunner,
): Promise<boolean> {
	const exists = await innerSessionExistsAsync(sessionName, run);
	if (!exists) reportHeldBack(issueKey);
	return exists;
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
	launch?: AgentLaunch,
): Promise<boolean> {
	const traceDone = startupTrace.current?.begin('agent-session');
	const identity = storedIdentity(issueKey);
	if (!identity) {
		traceDone?.('failed');
		return false;
	}

	const sessionName = identity.tmux.agentSession;
	const resumed = await resumeAgentSession(issueKey, sessionName, run);
	if (resumed !== 'absent') {
		traceDone?.(resumed === 'failed' ? 'failed' : undefined);
		return resumed === 'resumed';
	}

	const worktreePath = explicitWorktreePath ?? existingDirectory(identity);
	if (!worktreePath) {
		log.warn(`Cannot create agent session for ${issueKey}: no worktree found`);
		traceDone?.('failed');
		return false;
	}

	// Pre-trust the worktree directory so Claude or agy doesn't stop on a
	// folder-trust prompt on first launch.
	if (agentProfile.isClaude) {
		pretrustDirectoryForClaude(worktreePath);
	} else if (isAgyCommand(agentProfile.command)) {
		pretrustDirectoryForAgy(worktreePath);
	}

	if (launch?.rules) {
		try {
			await installAgentRules(agentProfile.command, worktreePath, {
				space: issueKey,
				repo: identity.repo,
				role: launch.name === SOUS_CHEF_NAME ? 'sous-chef' : 'worker',
			});
		} catch (err) {
			log.warn(
				`Could not write the companion rules for ${issueKey}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
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
				launch,
			),
			true,
		),
	];

	// Without it the agent's hook records no session ids, which costs less
	// than not starting the agent.
	await spaceState()
		.write(issueKey, {
			agentProfile: {name: agentProfile.name, isClaude: agentProfile.isClaude},
		})
		.catch((error: unknown) => {
			log.warn(
				`Could not record the agent profile of ${issueKey}`,
				error instanceof Error ? error : undefined,
			);
		});
	try {
		await run(
			innerTmuxArgs([
				'new-session',
				'-d',
				'-s',
				sessionName,
				'-c',
				tmuxFormatLiteral(worktreePath),
				...spaceSessionEnvArgs(issueKey),
				...buildAgentSessionEnvArgs(agentProfile.env),
				...launchArgs,
				';',
				'set-option',
				'-t',
				exactSessionTarget(sessionName),
				STARTUP_GATE_OPTION,
				gate,
				...hideStatusBarArgs(sessionName),
				...INNER_SERVER_KEEP_ALIVE_ARGS,
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
 * `new-session` for a space's companion or one of its splits. An empty command
 * means "leave a plain shell". The default command carries
 * GIT_OPTIONAL_LOCKS=0, which keeps the git UI from acquiring locks for
 * read-only ops like `git status`, avoiding contention with Claude's
 * concurrent git calls. Custom commands run verbatim.
 */
function companionSessionArgs(
	issueKey: string,
	sessionName: string,
	cwd: string,
	command: string,
	repoName?: string,
): string[] {
	return [
		'new-session',
		'-d',
		'-s',
		sessionName,
		'-c',
		tmuxFormatLiteral(cwd),
		...spaceSessionEnvArgs(issueKey, repoName),
		...(command.trim() === '' ? [] : buildShellLaunchArgs(command)),
		...hideStatusBarArgs(sessionName),
		...INNER_SERVER_KEEP_ALIVE_ARGS,
	];
}

export type CreateSplitResult =
	| {ok: true; session: string}
	| {ok: false; reason: string};

/**
 * Start a companion split as a session of its own, in the directory the
 * space's companion session started in, so a split of the main space runs in
 * the main checkout. `order` places it among the splits, and defaults to now.
 */
export function createCompanionSplit(
	identity: SpaceIdentity,
	split: {
		name: string;
		command: string;
		split: SplitDirection;
		size?: PaneWidth;
		order?: number;
	},
	options: {runner?: OuterTmuxRunner} = {},
): CreateSplitResult {
	const runner = options.runner ?? defaultInnerTmuxRunner;
	const failure = (args: string[], result: ReturnType<OuterTmuxRunner>) =>
		`tmux ${args[0]} failed: ${tmuxFailure(result)}`;
	const main = identity.tmux.companionSession;
	const pathArgs = [
		'display-message',
		'-p',
		'-t',
		exactSessionTarget(main),
		'#{session_path}',
	];
	const cwd = runner(pathArgs);
	if (cwd.error || cwd.status !== 0)
		return {ok: false, reason: failure(pathArgs, cwd)};
	const session = splitSessionName(main, split.name);
	const createArgs = [
		...companionSessionArgs(
			identity.key,
			session,
			cwd.stdout.trim(),
			split.command,
			identity.repo,
		),
		';',
		...splitOptionArgs(session, 'split', split.split),
		';',
		...splitOptionArgs(session, 'order', split.order ?? Date.now()),
		...(split.size === undefined
			? []
			: [';', ...splitOptionArgs(session, 'size', split.size)]),
	];
	const created = runner(createArgs);
	if (created.error || created.status !== 0)
		return {ok: false, reason: failure(createArgs, created)};
	return {ok: true, session};
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
	const identity = storedIdentity(issueKey);
	if (!identity) {
		traceDone?.('failed');
		return false;
	}

	const sessionName = identity.tmux.companionSession;

	// Already exists on the inner socket?
	if (await innerSessionExistsAsync(sessionName, run)) {
		traceDone?.();
		return true;
	}

	const worktreePath = explicitWorktreePath ?? existingDirectory(identity);
	if (!worktreePath) {
		log.warn(
			`Cannot create companion session for ${issueKey}: no worktree found`,
		);
		traceDone?.('failed');
		return false;
	}

	try {
		await run(
			innerTmuxArgs(
				companionSessionArgs(
					issueKey,
					sessionName,
					worktreePath,
					companionCommand,
				),
			),
		);

		// `pappardelle companion` addresses panes by name; the first one is main.
		// It names main itself when this fails, so the failure doesn't matter.
		await run(
			innerTmuxArgs([
				'set-option',
				'-p',
				'-t',
				`=${sessionName}:`,
				'@pappa_pane',
				MAIN_PANE,
			]),
		).catch(() => undefined);
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
