// What a space's agent is doing, for agents that supervise other spaces. The
// status Pappardelle already tracks decides working, idle and blocked; the
// screen adds what the agent is blocked on and the states only the screen
// shows: a Codex usage limit and a draft in its composer.

import {
	getClaudeStatusInfoAsync,
	type ClaudeStatusInfo,
} from './claude-status.ts';
import {
	parseAgentScreen,
	type AgentScreen,
	type PermissionPrompt,
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
	getSessionNames,
	resolveInnerSessionTargetSync,
	type OuterTmuxRunner,
} from './tmux.ts';
import {mergeProgramStatus} from './workspace-status.ts';

export type AgentState =
	| 'working'
	| 'permission'
	| 'question'
	| 'auth'
	| 'usage_limit'
	| 'draft'
	| 'idle'
	| 'no_session';

export type WaitTarget = 'working' | 'idle' | 'blocked' | 'ready' | 'changed';

const BLOCKED: readonly AgentState[] = [
	'permission',
	'question',
	'auth',
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

	if (screen.usageLimit) return 'usage_limit';
	if (status?.status === 'working' || screen.spinner) return 'working';
	if (screen.composer) return 'draft';
	return 'idle';
}

export type AgentStateDeps = {
	repo: string;
	runner: OuterTmuxRunner;
	now: () => Date;
	/** The hook file's key: the space key, or `{repo}-{branch}` for main. */
	hookKey: string;
	readHook?: (key: string) => Promise<ClaudeStatusInfo | null>;
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

export function captureAgentScreen(
	key: string,
	lines: number,
	deps: Pick<AgentStateDeps, 'repo' | 'runner'>,
): string | null {
	const target = resolveInnerSessionTargetSync(
		getSessionNames(key, deps.repo).agent,
		deps.runner,
	);
	if (!target) return null;
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
	const capture = captureAgentScreen(key, SCREEN_TAIL_LINES, deps);
	const screen =
		capture === null ? null : parseAgentScreen(capture, deps.now());
	const pane = screen
		? pinnedStatusPane(getSessionNames(key, repo).agent, runner)
		: null;
	const status = mergeProgramStatus(
		await (deps.readHook ?? getClaudeStatusInfoAsync)(deps.hookKey),
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
		composer: screen?.composer ?? null,
		screen: (screen?.lines ?? [])
			.filter(line => line.trim() !== '')
			.slice(-SCREEN_TAIL_LINES)
			.join('\n'),
	};
}
