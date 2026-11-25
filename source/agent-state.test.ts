import {agentScreenFixture as fixture} from '../test/helpers/agent-screens.ts';
import {idowIdentities} from '../test/helpers/state.ts';
import {test, expect} from 'bun:test';
import {thrownBy} from '../test/helpers/thrown.ts';
import {readAgentState, WAIT_TARGETS} from './agent-state.ts';
import type {ClaudeStatusInfo} from './claude-status.ts';
import {
	supervisedInnerTmuxRunner,
	supervisedServerTmuxRunner,
	type OuterTmuxRunner,
} from './tmux.ts';

/** One live agent session, `agent-repo-STA-1`, showing `screen`. */
function runner(screen: string | null): OuterTmuxRunner {
	return args => {
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: screen === null ? '' : 'agent-repo-STA-1\n'};
		}

		if (args[0] === 'capture-pane') return {status: 0, stdout: screen ?? ''};
		return {status: 1, stdout: ''};
	};
}

const state = async (
	screen: string | null,
	hook: Partial<ClaudeStatusInfo> | null = null,
) =>
	readAgentState('STA-1', {
		identities: idowIdentities('repo', () => ['STA-1']),
		runner: runner(screen),
		now: () => new Date(2026, 10, 9, 12, 0),
		async sleep() {},
		hookKey: 'STA-1',
		async readHook() {
			if (!hook) return null;
			const info: ClaudeStatusInfo = {status: 'unknown', ...hook};
			return info;
		},
		readSnapshot: async () => null,
	});
const stateOf = async (
	screen: string | null,
	hook: Partial<ClaudeStatusInfo> | null = null,
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

	expect(WAIT_TARGETS.ready.includes('working')).toBe(false);
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
