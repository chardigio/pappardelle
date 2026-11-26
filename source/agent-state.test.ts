import {agentScreenFixture as fixture} from '../test/helpers/agent-screens.ts';
import {snapshotOf} from '../test/helpers/program-status.ts';
import {idowIdentities} from '../test/helpers/state.ts';
import {test, expect} from 'bun:test';
import {thrownBy} from '../test/helpers/thrown.ts';
import {parseAgentScreen} from './agent-screen.ts';
import {classifyAgent, readAgentState, WAIT_TARGETS} from './agent-state.ts';
import type {ClaudeStatusInfo} from './claude-status.ts';
import {
	parseStatusPane,
	statusSocket,
	type ProgramStatusSnapshot,
} from './program-status-monitor.ts';
import {
	supervisedInnerTmuxRunner,
	supervisedServerTmuxRunner,
	type OuterTmuxRunner,
} from './tmux.ts';

/** One live agent session, `agent-repo-STA-1`, showing `screen`. */
function runner(screen: string | null, paneListing?: string): OuterTmuxRunner {
	return args => {
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: screen === null ? '' : 'agent-repo-STA-1\n'};
		}

		if (args[0] === 'capture-pane') return {status: 0, stdout: screen ?? ''};
		if (args[0] === 'list-panes' && paneListing !== undefined) {
			return {status: 0, stdout: paneListing};
		}

		return {status: 1, stdout: ''};
	};
}

const state = async (
	screen: string | null,
	hook: Partial<ClaudeStatusInfo> = {},
	options: {
		paneListing?: string;
		snapshot?: ProgramStatusSnapshot | null;
	} = {},
) =>
	readAgentState('STA-1', {
		identities: idowIdentities('repo', () => ['STA-1']),
		runner: runner(screen, options.paneListing),
		now: () => new Date(2026, 10, 9, 12, 0),
		async sleep() {},
		hookKey: 'STA-1',
		readHook: async () => ({status: 'unknown', ...hook}),
		readSnapshot: async () => options.snapshot ?? null,
	});
const stateOf = async (
	screen: string | null,
	hook: Partial<ClaudeStatusInfo> = {},
) => {
	const report = await state(screen, hook);
	return report.state;
};

test('a prompt on screen wins over a hook that still says working', async () => {
	const report = await state(fixture('claude-permission-bash'), {
		status: 'processing',
	});
	expect(report.state).toBe('permission');
	expect(report.permission?.command).toBe('cksum greet.js');
});

test("a blocked hook is a prompt even when the screen doesn't parse one", async () => {
	const blocked = (tool: string): Partial<ClaudeStatusInfo> => ({
		status: 'waiting_for_approval',
		tool,
	});
	expect(await stateOf('❯ ', blocked('Write'))).toBe('permission');
	expect(await stateOf('❯ ', blocked('AskUserQuestion'))).toBe('question');
});

test('the screen alone shows a Codex usage limit, a draft and a spinner', async () => {
	expect(await stateOf(fixture('codex-limit-narrow'))).toBe('usage_limit');
	expect(await stateOf(fixture('codex-draft'))).toBe('draft');
	expect(await stateOf(fixture('claude-working'))).toBe('working');
	expect(await stateOf(fixture('claude-idle'))).toBe('idle');
	expect(await stateOf(fixture('claude-suggestion-named'))).toBe('idle');
	expect(await stateOf(fixture('claude-draft-named'))).toBe('draft');
	expect(await stateOf(fixture('claude-shell-draft'))).toBe('draft');
	expect(await stateOf(fixture('claude-shell-empty'))).toBe('idle');
	expect(await stateOf(fixture('agy-subagent-manage'))).toBe('dialog');
});

test('a space with no agent session says so', async () => {
	expect(await stateOf(null)).toBe('no_session');
});

test('every blocked state counts as ready, and working never does', () => {
	for (const blocked of WAIT_TARGETS.blocked) {
		expect(WAIT_TARGETS.ready.includes(blocked)).toBe(true);
	}

	expect(WAIT_TARGETS.ready.includes('exited')).toBe(true);
	expect(WAIT_TARGETS.ready.includes('working')).toBe(false);
});

const paneRow = (
	command: string,
	{
		pinned = '%1',
		pid = '42',
		dead = false,
		piped = !dead,
		marker = '42.marker',
		createdSeconds,
	}: {
		pinned?: string;
		pid?: string;
		dead?: boolean;
		piped?: boolean;
		marker?: string;
		createdSeconds?: number;
	} = {},
) =>
	[
		'11',
		pinned,
		'%1',
		pid,
		dead ? '1' : '0',
		piped ? '1' : '0',
		marker,
		command,
		...(createdSeconds === undefined ? [] : [String(createdSeconds)]),
	].join('\t') + '\n';

test('dead pane and exited-to-shell panes classify as exited, not idle or permission', async () => {
	// Dead remain-on-exit pane overrides stale hook and frozen prompt on screen.
	const dead = await state(
		fixture('claude-permission-bash'),
		{status: 'waiting_for_approval', tool: 'Bash'},
		{paneListing: paneRow('bash', {pid: '', dead: true})},
	);
	expect(dead.state).toBe('exited');
	expect(dead.permission).toBe(null);

	// Unmonitored dead remain-on-exit pane on tmux 3.8+ (empty pane_pid and marker).
	const unmonitoredDead = await state(
		fixture('claude-permission-bash'),
		{status: 'waiting_for_approval', tool: 'Bash'},
		{
			paneListing: paneRow('bash', {
				pinned: '',
				pid: '',
				dead: true,
				marker: '',
			}),
		},
	);
	expect(unmonitoredDead.state).toBe('exited');
	expect(unmonitoredDead.permission).toBe(null);

	// Alive pane back at login shell after OSC 133;A cleared idle classifies as exited.
	const pane = parseStatusPane('%1\t42\t0\t1\t42.marker', statusSocket())!;
	const target = {repo: 'repo', key: 'STA-1', pane};
	const shellAfterOsc = await state(
		'[user@host qa-a1]$ ',
		{},
		{
			paneListing: paneRow('zsh'),
			snapshot: snapshotOf(target, [], {updatedAt: 0}),
		},
	);
	expect(shellAfterOsc.state).toBe('exited');

	// Alive pane back at shell after Claude's hook reported also classifies as exited.
	const shellAfterHook = await state(
		'[user@host qa-a1]$ ',
		{status: 'ended'},
		{paneListing: paneRow('bash')},
	);
	expect(shellAfterHook.state).toBe('exited');

	// Exited-to-shell after crash where OSC snapshot retained `done`.
	const crashedAfterDone = await state(
		'[user@host qa-a1]$ ',
		{},
		{
			paneListing: paneRow('bash'),
			snapshot: snapshotOf(
				target,
				[{state: 'done', id: '', app: 'antigravity'}],
				{updatedAt: 0},
			),
		},
	);
	expect(crashedAfterDone.state).toBe('exited');

	// Live agent with a composer or non-shell process stays idle, never exited.
	const liveComposer = await state(
		fixture('agy-idle'),
		{},
		{
			paneListing: paneRow('bash'),
		},
	);
	expect(liveComposer.state).toBe('idle');

	const nonShell = await state(
		'',
		{},
		{
			paneListing: paneRow('agy'),
		},
	);
	expect(nonShell.state).toBe('idle');
});

test('a shell foreground with no prior agent status source does not classify as exited', async () => {
	// A newly created space still running its login shell before the agent
	// launches (or an unmonitored test stub) has no status source yet.
	const noStatus = await state(
		'',
		{},
		{
			paneListing: paneRow('bash'),
		},
	);
	expect(noStatus.state).toBe('idle');

	const unknownHook = await state(
		'',
		{status: 'unknown'},
		{paneListing: paneRow('zsh')},
	);
	expect(unknownHook.state).toBe('idle');

	// A respawned Claude space still starting in its shell has an older hook
	// record on disk (lastUpdate < session_created): do not classify as exited.
	const sessionCreatedSeconds = 1_764_162_700;
	const createdListing = paneRow('bash', {
		createdSeconds: sessionCreatedSeconds,
	});
	const staleHook = await state(
		'',
		{status: 'ended', lastUpdate: sessionCreatedSeconds * 1000 - 1000},
		{paneListing: createdListing},
	);
	expect(staleHook.state).toBe('idle');

	// Once Claude has reported in this session (lastUpdate >= session_created),
	// returning to the shell classifies as exited.
	const freshHook = await state(
		'',
		{status: 'ended', lastUpdate: sessionCreatedSeconds * 1000},
		{paneListing: createdListing},
	);
	expect(freshHook.state).toBe('exited');
});

test('agy trust, /artifact review, and plan-approval OSC blocked states classify accurately', () => {
	const now = new Date(2026, 10, 9, 12, 0);
	const oscBlocked = (message: string) => ({
		status: 'blocked' as const,
		kind: 'permission' as const,
		app: 'antigravity',
		message,
		source: 'osc' as const,
	});

	expect(
		classifyAgent(
			oscBlocked('Trust this folder?'),
			parseAgentScreen(fixture('agy-trust'), now),
		),
	).toBe('dialog');

	expect(
		classifyAgent(
			oscBlocked('Approve plan'),
			parseAgentScreen(fixture('agy-plan-artifact-review'), now),
		),
	).toBe('dialog');

	expect(
		classifyAgent(
			oscBlocked('Approve plan'),
			parseAgentScreen(fixture('agy-plan-approval'), now),
		),
	).toBe('idle');

	// A real unparsed tool/subagent prompt must never be swallowed by a lingering artifact banner.
	expect(
		classifyAgent(
			oscBlocked('Approve Bash: rm -rf /'),
			parseAgentScreen(fixture('agy-plan-approval'), now),
		),
	).toBe('permission');

	const planWithDraft = parseAgentScreen(
		[
			'  1 artifact · /artifact to review',
			'────────────────────',
			'\u001B[94m>\u001B[39m add a step 3',
			'────────────────────',
			'-- INSERT -- ? for shortcuts   plan · Gemini 4 Hydrogen · medium',
		].join('\n'),
		now,
	);
	expect(classifyAgent(oscBlocked('Approve plan'), planWithDraft)).toBe(
		'draft',
	);
});

test('the supervision runners refuse to end any tmux session', () => {
	for (const verb of ['kill-server', 'kill-session', 'kill-pane']) {
		{
			const error = thrownBy(() => supervisedInnerTmuxRunner([verb]));
			expect(error.message).toBe(`Supervision never runs tmux ${verb}`);
		}
		expect(() => supervisedServerTmuxRunner([verb, '-t', 'x'])).toThrow();
	}
});
