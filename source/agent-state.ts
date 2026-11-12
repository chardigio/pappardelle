// What a space's agent is doing, for agents that supervise other spaces. The
// status Pappardelle already tracks decides working, idle and blocked; the
// screen adds what the agent is blocked on and the states only the screen
// shows: a Codex usage limit and a draft in its composer.

import type {ClaudeStatusInfo} from './claude-status.ts';
import {
	parseAgentScreen,
	type AgentScreen,
	type PermissionPrompt,
	type CodexDialog,
	type QuestionDialog,
	type UsageLimit,
} from './agent-screen.ts';
import {
	parseStatusPane,
	readProgramSnapshot,
	STATUS_PANE_FORMAT,
	STATUS_PANE_OPTION,
	statusSocket,
	type ProgramStatusSnapshot,
	type StatusPane,
} from './program-status-monitor.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import {
	exactSessionTarget,
	fromSessionKey,
	getSessionNames,
	getSessionPrefix,
	resolveInnerSessionTargetSync,
	type OuterTmuxRunner,
} from './tmux.ts';
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
	ready: ['idle', 'draft', 'no_session', ...BLOCKED],
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
	composer: string | null;
	screen: string;
};

export function classifyAgent(
	status: ProgramStatusInfo | null,
	screen: AgentScreen | null,
): AgentState {
	if (!screen) return 'no_session';
	if (screen.permission) return 'permission';
	if (screen.question) return 'question';
	// Claude's hook says it's blocked for prompts the screen doesn't parse.
	if (status?.status === 'blocked') {
		if (status.kind === 'question') return 'question';
		if (status.kind === 'auth') return 'auth';
		return 'permission';
	}

	if (screen.codexDialog) return 'dialog';
	if (screen.usageLimit) return 'usage_limit';
	if (status?.status === 'working' || screen.spinner) return 'working';
	if (screen.composer) return 'draft';
	return 'idle';
}

export type AgentStateDeps = {
	repo: string;
	runner: OuterTmuxRunner;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	/** The hook file's key: the space key, or `{repo}-{branch}` for main. */
	hookKey: string;
	readHook: (key: string) => Promise<ClaudeStatusInfo | null>;
	readSnapshot?: (
		repo: string,
		key: string,
		pane: StatusPane,
	) => ProgramStatusSnapshot | null;
};

const SCREEN_TAIL_LINES = 40;

function tmuxOut(runner: OuterTmuxRunner, args: string[]): string | null {
	const result = runner(args);
	return result.error || result.status !== 0 ? null : result.stdout;
}

/**
 * The pane the TUI's status monitor pinned, read without attaching one: that
 * stays the TUI's job, and attaching from here would race it.
 */
function pinnedStatusPane(
	session: string,
	runner: OuterTmuxRunner,
): StatusPane | null {
	const target = exactSessionTarget(session);
	const pinned = tmuxOut(runner, [
		'show-option',
		'-qv',
		'-t',
		target,
		STATUS_PANE_OPTION,
	])?.trim();
	const pane = tmuxOut(runner, [
		'display-message',
		'-p',
		'-t',
		pinned || target,
		STATUS_PANE_FORMAT,
	]);
	return pane ? parseStatusPane(pane, statusSocket()) : null;
}

/** The keys of every space in `repo` with an agent session. */
export function listAgentKeys(repo: string, runner: OuterTmuxRunner): string[] {
	const prefix = getSessionPrefix('agent', repo);
	return (tmuxOut(runner, ['list-sessions', '-F', '#{session_name}']) ?? '')
		.split('\n')
		.filter(name => name.startsWith(prefix))
		.map(name => fromSessionKey(name.slice(prefix.length)));
}

// A window nobody is viewing keeps the size of whatever last showed it: a
// phone's, or tmux's 80x24 for one never shown. The agent draws a dialog only
// within it, on the alternate screen with no scrollback to read the rest from,
// so a question with a few described options loses its top. Before a read, a
// window no client shows grows to at least this, and the next client to show
// it sizes it to itself again.
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

export async function captureAgentScreen(
	key: string,
	lines: number,
	deps: Pick<AgentStateDeps, 'repo' | 'runner' | 'sleep'>,
): Promise<string | null> {
	const target = resolveInnerSessionTargetSync(
		getSessionNames(key, deps.repo).agent,
		deps.runner,
	);
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
	const {repo, runner} = deps;
	const capture = await captureAgentScreen(key, SCREEN_TAIL_LINES, deps);
	const screen =
		capture === null ? null : parseAgentScreen(capture, deps.now());
	const pane = screen
		? pinnedStatusPane(getSessionNames(key, repo).agent, runner)
		: null;
	const status = mergeProgramStatus(
		await deps.readHook(deps.hookKey),
		pane ? (deps.readSnapshot ?? readProgramSnapshot)(repo, key, pane) : null,
		pane,
	);
	return {
		key,
		state: classifyAgent(status, screen),
		app: status?.app ?? null,
		status,
		permission: screen?.permission ?? null,
		question: screen?.question ?? null,
		usageLimit: screen?.usageLimit ?? null,
		codexDialog: screen?.codexDialog ?? null,
		composer: screen?.composer ?? null,
		screen: (screen?.lines ?? [])
			.map(line => line.trimEnd())
			.filter(line => line !== '')
			.slice(-SCREEN_TAIL_LINES)
			.join('\n'),
	};
}
