import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {readAgentState, WAIT_TARGETS} from './agent-state.ts';
import type {ClaudeStatusInfo} from './claude-status.ts';
import {
	supervisedInnerTmuxRunner,
	supervisedServerTmuxRunner,
	type OuterTmuxRunner,
} from './tmux.ts';

const fixtures = path.join(
	import.meta.dirname,
	'..',
	'test',
	'fixtures',
	'agent-screens',
);
const fixture = (name: string) =>
	fs.readFileSync(path.join(fixtures, `${name}.txt`), 'utf8');

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
		repo: 'repo',
		runner: runner(screen),
		now: () => new Date(2026, 10, 9, 12, 0),
		hookKey: 'STA-1',
		async readHook() {
			if (!hook) return null;
			const info: ClaudeStatusInfo = {status: 'unknown', ...hook};
			return info;
		},
	});
const stateOf = async (
	screen: string | null,
	hook: Partial<ClaudeStatusInfo> | null = null,
) => {
	const report = await state(screen, hook);
	return report.state;
};

test('a prompt on screen wins over a hook that still says working', async t => {
	const report = await state(fixture('claude-permission-bash'), {
		status: 'processing',
	});
	t.is(report.state, 'permission');
	t.is(report.permission?.command, 'cksum greet.js');
});

test("a blocked hook is a prompt even when the screen doesn't parse one", async t => {
	const blocked = (tool: string): Partial<ClaudeStatusInfo> => ({
		status: 'waiting_for_approval',
		tool,
	});
	t.is(await stateOf('❯ ', blocked('Write')), 'permission');
	t.is(await stateOf('❯ ', blocked('AskUserQuestion')), 'question');
});

test('the screen alone shows a Codex usage limit, a draft and a spinner', async t => {
	t.is(await stateOf(fixture('codex-limit-narrow')), 'usage_limit');
	t.is(await stateOf(fixture('codex-draft')), 'draft');
	t.is(await stateOf(fixture('claude-working')), 'working');
	t.is(await stateOf(fixture('claude-idle')), 'idle');
});

test('a space with no agent session says so', async t => {
	t.is(await stateOf(null), 'no_session');
});

test('every blocked state counts as ready, and working never does', t => {
	for (const blocked of WAIT_TARGETS.blocked) {
		t.true(WAIT_TARGETS.ready.includes(blocked));
	}

	t.false(WAIT_TARGETS.ready.includes('working'));
});

test('the supervision runners refuse to end any tmux session', t => {
	for (const verb of ['kill-server', 'kill-session', 'kill-pane']) {
		t.throws(() => supervisedInnerTmuxRunner([verb]), {
			message: `Supervision never runs tmux ${verb}`,
		});
		t.throws(() => supervisedServerTmuxRunner([verb, '-t', 'x']));
	}
});
