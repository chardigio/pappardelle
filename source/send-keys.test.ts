import test from 'ava';
import {sendKeysToSpaceAgent, type OuterTmuxRunner} from './tmux.ts';

function recorder(sessions: string[], failOn?: string) {
	const calls: string[][] = [];
	const runner: OuterTmuxRunner = args => {
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
