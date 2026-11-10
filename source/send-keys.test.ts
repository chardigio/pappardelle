import test from 'ava';
import {sendKeysToSpaceAgent, type OuterTmuxRunner} from './tmux.ts';

function recorder(sessions: string[], failOn?: string, screen = '') {
	const calls: string[][] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'capture-pane') return {status: 0, stdout: screen};
		calls.push([...args]);
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: sessions.join('\n') + '\n'};
		return {status: args.at(-1) === failOn ? 1 : 0, stdout: ''};
	};

	return {runner, calls};
}

test('--keys presses each key name in order with no C-u, -l or Enter', t => {
	const {runner, calls} = recorder(['agent-repo-STA-1']);
	t.is(
		sendKeysToSpaceAgent('STA-1', ['Escape', 'S-Tab'], {
			repoName: 'repo',
			runner,
		}),
		'sent',
	);
	t.deepEqual(calls.slice(1), [
		['send-keys', '-t', '=agent-repo-STA-1:', 'Escape'],
		['send-keys', '-t', '=agent-repo-STA-1:', 'S-Tab'],
	]);
});

test('--keys reports a missing session and stops at a failed key', t => {
	const missing = recorder(['agent-repo-STA-12']);
	t.is(
		sendKeysToSpaceAgent('STA-1', ['Escape'], {
			repoName: 'repo',
			runner: missing.runner,
		}),
		'no-session',
	);
	const failing = recorder(['agent-repo-STA-1'], 'S-Tab');
	t.is(
		sendKeysToSpaceAgent('STA-1', ['S-Tab', 'Enter'], {
			repoName: 'repo',
			runner: failing.runner,
		}),
		'failed',
	);
	t.is(failing.calls.length, 2);
});

test('--keys never answers a prompt; Escape still declines it', t => {
	const prompt = [
		'────────',
		' Bash command',
		' rm -rf /home/u',
		' Do you want to proceed?',
		' ❯ 1. Yes',
		'   2. No',
	].join('\n');
	const {runner, calls} = recorder(['agent-repo-STA-1'], undefined, prompt);
	const press = (keys: string[], answering = false) =>
		sendKeysToSpaceAgent('STA-1', keys, {repoName: 'repo', runner, answering});
	t.is(press(['1']), 'prompt');
	t.is(press(['Enter']), 'prompt');
	t.is(press(['Escape']), 'sent');
	t.is(press(['1'], true), 'sent');
	t.deepEqual(
		calls.filter(args => args[0] === 'send-keys').map(args => args.at(-1)),
		['Escape', '1'],
	);
});

test('--keys never touches a Codex dialog, where Escape can quit Codex', t => {
	const trust = [
		'  Do you trust the contents of this directory?',
		'› 1. Yes, continue',
		'  2. No, quit',
		'  enter continue · esc quit',
	].join('\n');
	const {runner} = recorder(['agent-repo-STA-1'], undefined, trust);
	t.is(
		sendKeysToSpaceAgent('STA-1', ['Escape'], {repoName: 'repo', runner}),
		'prompt',
	);
});
