// What a space's agent is doing, for agents that supervise other spaces. The
// status Pappardelle already tracks decides working, idle and blocked; the
// screen adds what the agent is blocked on and the states only the screen
// shows: a Codex usage limit and a draft in its composer.

import path from 'node:path';
import type {ClaudeStatusInfo} from './claude-status.ts';
import {
	parseAgentScreen,
	type AgentScreen,
	type AgyDialogKind,
	type PermissionPrompt,
	type CodexDialog,
	type QuestionDialog,
	type UsageLimit,
} from './agent-screen.ts';
import {
	parseStatusPane,
	STATUS_PANE_FORMAT,
	STATUS_PANE_OPTION,
	statusSocket,
	type ProgramStatusSnapshot,
	type StatusPane,
} from './program-status-monitor.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import {
	exactSessionTarget,
	resolveInnerSessionTargetSync,
	type OuterTmuxRunner,
} from './tmux.ts';
import type {SpaceIdentityDao} from './space-identity.ts';
import {mergeProgramStatus} from './workspace-status.ts';

export const AGENT_STATES = [
	'working',
	'permission',
	'question',
	'auth',
	'dialog',
	'usage_limit',
	'draft',
	'idle',
	'exited',
	'no_session',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export type WaitTarget = 'working' | 'idle' | 'blocked' | 'ready' | 'changed';

export const BLOCKED: readonly AgentState[] = [
	'permission',
	'question',
	'auth',
	'dialog',
	'usage_limit',
];

/** The states each `wait --until` target accepts; `changed` is any new state. */
export const WAIT_TARGETS: Record<
	Exclude<WaitTarget, 'changed'>,
	readonly AgentState[]
> = {
	working: ['working'],
	idle: ['idle', 'draft'],
	blocked: BLOCKED,
	ready: ['idle', 'draft', 'exited', 'no_session', ...BLOCKED],
};

export type AgentStateReport = {
	key: string;
	state: AgentState;
	/** The agent app that reported natively, such as `codex` or `claude-code`. */
	app: string | null;
	status: ProgramStatusInfo | null;
	permission: PermissionPrompt | null;
	question: QuestionDialog | null;
	usageLimit: UsageLimit | null;
	codexDialog: CodexDialog | null;
	agyDialog: AgyDialogKind | null;
	composer: string | null;
	screen: string;
};

export type AgentPaneState = {
	dead?: boolean;
	currentCommand?: string | null;
};

const SHELL_COMMANDS = new Set([
	'sh',
	'bash',
	'zsh',
	'fish',
	'dash',
	'ksh',
	'mksh',
	'yash',
	'ash',
	'csh',
	'tcsh',
	'nu',
	'xonsh',
	'elvish',
	'pwsh',
]);

function normalizeCommandName(command: string | null | undefined): string {
	return command ? path.posix.basename(command.trim()).replace(/^-/, '') : '';
}

export function isShellCommand(command: string | null | undefined): boolean {
	const base = normalizeCommandName(command);
	if (!base) return false;
	if (SHELL_COMMANDS.has(base)) return true;
	const userShell = normalizeCommandName(process.env['SHELL']);
	return userShell !== '' && base === userShell;
}

export function classifyAgent(
	status: ProgramStatusInfo | null,
	screen: AgentScreen | null,
	pane?: AgentPaneState | null,
): AgentState {
	if (!screen) return 'no_session';
	if (pane?.dead) return 'exited';
	if (screen.permission) return 'permission';
	if (screen.question) return 'question';
	// Modal dialogs (such as agy's trust dialog or /artifact review) can also
	// carry an OSC blocked/permission report; classify them as dialog first.
	if (screen.codexDialog || screen.agyDialog) return 'dialog';
	// Claude's hook or OSC says it's blocked for prompts the screen doesn't parse.
	// Agy keeps OSC blocked/permission "Approve plan" while showing its open
	// composer under `N artifact · /artifact to review`; that is not a modal prompt.
	if (status?.status === 'blocked') {
		if (status.kind === 'question') return 'question';
		if (status.kind === 'auth') return 'auth';
		const isArtifactBanner =
			status.message === 'Approve plan' &&
			Boolean(screen.agyComposer?.artifactReview);
		if (!isArtifactBanner) return 'permission';
	}

	if (screen.usageLimit) return 'usage_limit';
	if (status?.status === 'working' || screen.spinner) return 'working';
	if (screen.composer) return 'draft';
	// Require a prior status source so a newly started shell (or unmonitored stub)
	// running before the agent launches does not report as exited.
	if (
		screen.composer === null &&
		Boolean(status?.source) &&
		isShellCommand(pane?.currentCommand)
	) {
		return 'exited';
	}

	return 'idle';
}

export type AgentStateDeps = {
	identities: Pick<SpaceIdentityDao, 'get'>;
	runner: OuterTmuxRunner;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	/** The hook file's key: the space key, or `{repo}-{branch}` for main. */
	hookKey: string;
	readHook: (key: string) => Promise<ClaudeStatusInfo | null>;
	readSnapshot: (
		key: string,
		pane: StatusPane,
	) => Promise<ProgramStatusSnapshot | null>;
};

const SCREEN_TAIL_LINES = 40;

function tmuxOut(runner: OuterTmuxRunner, args: string[]): string | null {
	const result = runner(args);
	return result.error || result.status !== 0 ? null : result.stdout;
}

/**
 * A `list-panes` format for picking a session's status pane with
 * `statusPaneOf`: whether the pane is the session's current one, the pane
 * the session pinned, and the pane's status fields.
 */
export const AGENT_PANE_FORMAT = `#{window_active}#{pane_active}\t#{${STATUS_PANE_OPTION}}\t${STATUS_PANE_FORMAT}`;

function selectedStatusPaneRow(lines: string[]): string | undefined {
	const rows = lines.map(line => {
		const [active = '', pinned = '', ...pane] = line.split('\t');
		return {current: active === '11', pinned, pane: pane.join('\t')};
	});
	const pinned = rows.find(row => row.pinned)?.pinned;
	return (
		pinned
			? rows.find(each => each.pane.startsWith(`${pinned}\t`))
			: rows.find(each => each.current)
	)?.pane;
}

/**
 * The pane the TUI's status monitor pinned, else the session's current pane,
 * from one session's `AGENT_PANE_FORMAT` lines.
 */
export function statusPaneOf(
	lines: string[],
	socket: string,
): StatusPane | null {
	const pane = selectedStatusPaneRow(lines);
	return pane ? parseStatusPane(pane, socket) : null;
}

export type PinnedStatusPaneInfo = {
	pane: StatusPane | null;
	dead: boolean;
	currentCommand: string | undefined;
};

/**
 * The pane the TUI's status monitor pinned, read without attaching one: that
 * stays the TUI's job, and attaching from here would race it.
 */
export function pinnedStatusPaneInfo(
	session: string,
	runner: OuterTmuxRunner,
	socket = statusSocket(),
): PinnedStatusPaneInfo | null {
	const listing = tmuxOut(runner, [
		'list-panes',
		'-s',
		'-t',
		exactSessionTarget(session),
		'-F',
		`${AGENT_PANE_FORMAT}\t#{pane_current_command}`,
	]);
	if (!listing) return null;
	const row = selectedStatusPaneRow(listing.split('\n').filter(Boolean));
	if (!row) return null;
	const commandSeparator = row.lastIndexOf('\t');
	if (commandSeparator === -1) return null;
	const paneRow = row.slice(0, commandSeparator);
	const pane = parseStatusPane(paneRow, socket);
	// On tmux 3.8+, an unmonitored dead remain-on-exit pane has an empty
	// pane_pid and empty marker, so parseStatusPane returns null; read
	// pane_dead directly from the row so dead panes still classify as exited.
	const dead = pane?.dead ?? paneRow.split('\t')[2] === '1';
	const currentCommand = row.slice(commandSeparator + 1) || undefined;
	return {pane, dead, currentCommand};
}

/**
 * A space's status as the rail shows it: the hook's record merged with what
 * the agent reported on its pane, when the pane is known.
 */
export async function readAgentStatus(
	key: string,
	pane: StatusPane | null,
	deps: Pick<AgentStateDeps, 'hookKey' | 'readHook' | 'readSnapshot'>,
): Promise<ProgramStatusInfo | null> {
	return mergeProgramStatus(
		await deps.readHook(deps.hookKey),
		pane ? await deps.readSnapshot(key, pane) : null,
		pane,
	);
}

/** The keys of every space whose stored agent session is live. */
export function listAgentKeys(
	identities: Pick<SpaceIdentityDao, 'list'>,
	runner: OuterTmuxRunner,
): string[] {
	const listed = identities.list();
	if (listed.kind === 'unreadable') return [];
	const live = new Set(
		(tmuxOut(runner, ['list-sessions', '-F', '#{session_name}']) ?? '').split(
			'\n',
		),
	);
	return listed.identities
		.filter(identity => live.has(identity.tmux.agentSession))
		.map(identity => identity.key);
}

// A window nobody is viewing keeps the size of whatever last showed it: a
// phone's, or for one never shown the agent viewer's size when it was created
// (tmux's 80x24 if no rail had laid out since the inner server started). The
// agent draws a dialog only within it, on the alternate screen with no
// scrollback to read the rest from, so a question with a few described
// options loses its top. Before a read, a window no client shows grows to at
// least this, and the next client to show it sizes it to itself again.
export const READ_WINDOW = {columns: 120, rows: 60};
// Claude redraws within about 35 ms of a resize.
const REDRAW_MS = 200;

async function growUnviewedWindow(
	target: string,
	deps: Pick<AgentStateDeps, 'runner' | 'sleep'>,
): Promise<void> {
	const [attached, columns, rows] = (
		tmuxOut(deps.runner, [
			'display-message',
			'-p',
			'-t',
			target,
			'#{session_attached} #{window_width} #{window_height}',
		]) ?? ''
	)
		.trim()
		.split(' ')
		.map(Number);
	if (
		attached !== 0 ||
		columns === undefined ||
		rows === undefined ||
		(columns >= READ_WINDOW.columns && rows >= READ_WINDOW.rows)
	)
		return;
	const resized = deps.runner([
		'resize-window',
		'-t',
		target,
		'-x',
		String(Math.max(columns, READ_WINDOW.columns)),
		'-y',
		String(Math.max(rows, READ_WINDOW.rows)),
		';',
		// resize-window pins the window at its size; unset, it follows the
		// next client that shows it.
		'set-option',
		'-wu',
		'-t',
		target,
		'window-size',
	]);
	if (!resized.error && resized.status === 0) await deps.sleep(REDRAW_MS);
}

function agentSessionOf(
	key: string,
	deps: Pick<AgentStateDeps, 'identities'>,
): string | null {
	const lookup = deps.identities.get(key);
	return lookup.kind === 'identity' ? lookup.identity.tmux.agentSession : null;
}

export async function captureAgentScreen(
	key: string,
	lines: number,
	deps: Pick<AgentStateDeps, 'identities' | 'runner' | 'sleep'>,
): Promise<string | null> {
	const session = agentSessionOf(key, deps);
	const target = session && resolveInnerSessionTargetSync(session, deps.runner);
	if (!target) return null;
	await growUnviewedWindow(target, deps);
	return tmuxOut(deps.runner, [
		'capture-pane',
		'-p',
		'-e',
		'-J',
		'-S',
		`-${lines}`,
		'-t',
		target,
	]);
}

export async function readAgentState(
	key: string,
	deps: AgentStateDeps,
): Promise<AgentStateReport> {
	const {runner} = deps;
	const capture = await captureAgentScreen(key, SCREEN_TAIL_LINES, deps);
	const screen =
		capture === null ? null : parseAgentScreen(capture, deps.now());
	const session = agentSessionOf(key, deps);
	const paneInfo =
		screen && session ? pinnedStatusPaneInfo(session, runner) : null;
	const pane = paneInfo?.pane ?? null;
	const status = await readAgentStatus(key, pane, deps);
	const state = classifyAgent(status, screen, {
		dead: paneInfo?.dead,
		currentCommand: paneInfo?.currentCommand,
	});
	const live = state !== 'exited';
	return {
		key,
		state,
		app: status?.app ?? null,
		status,
		permission: live ? (screen?.permission ?? null) : null,
		question: live ? (screen?.question ?? null) : null,
		usageLimit: live ? (screen?.usageLimit ?? null) : null,
		codexDialog: live ? (screen?.codexDialog ?? null) : null,
		agyDialog: live ? (screen?.agyDialog ?? null) : null,
		composer: live ? (screen?.composer ?? null) : null,
		screen: (screen?.lines ?? [])
			.map(line => line.trimEnd())
			.filter(line => line !== '')
			.slice(-SCREEN_TAIL_LINES)
			.join('\n'),
	};
}
