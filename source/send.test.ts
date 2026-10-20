// Tests for `pappardelle send` (pappardelle-tqq): resolving a space's agent
// session on the inner socket and submitting a prompt to it.
import test from 'ava';
import {resolveSpaceKey} from './issue-utils.ts';
import {
	resolveInnerSessionTarget,
	sendToSpaceAgent,
	type OuterTmuxRunner,
} from './tmux.ts';

function makeRunner(options: {
	sessions?: string[];
	listFails?: boolean;
	failOn?: (args: readonly string[]) => boolean;
}): {runner: OuterTmuxRunner; sendKeysCalls: string[][]} {
	const sendKeysCalls: string[][] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions') {
			if (options.listFails) {
				return {status: 1, stdout: ''};
			}

			return {status: 0, stdout: (options.sessions ?? []).join('\n') + '\n'};
		}

		sendKeysCalls.push([...args]);
		return {status: options.failOn?.(args) ? 1 : 0, stdout: ''};
	};

	return {runner, sendKeysCalls};
}

test('resolveInnerSessionTarget returns an exact-match session target', t => {
	const {runner} = makeRunner({sessions: ['agent-r-main', 'agent-r-STA-1']});
	t.is(resolveInnerSessionTarget('agent-r-STA-1', runner), '=agent-r-STA-1:');
});

test('resolveInnerSessionTarget does not prefix-match a longer session name', t => {
	const {runner} = makeRunner({sessions: ['agent-r-STA-12']});
	t.is(resolveInnerSessionTarget('agent-r-STA-1', runner), null);
});

test('resolveInnerSessionTarget returns null when no inner server is running', t => {
	const {runner} = makeRunner({listFails: true});
	t.is(resolveInnerSessionTarget('agent-r-STA-1', runner), null);
});

test('sendToSpaceAgent targets the encoded session of a dotted key, clears the line, types the text literally, then sends Enter as its own call', t => {
	const text = `it's "quoted" \`tick\` $HOME \\n; rm -rf nope`;
	const {runner, sendKeysCalls} = makeRunner({
		sessions: ['agent-r-agc_17'],
	});

	t.is(sendToSpaceAgent('agc.17', text, {repoName: 'r', runner}), 'sent');
	t.deepEqual(sendKeysCalls, [
		['send-keys', '-t', '=agent-r-agc_17:', 'C-u'],
		['send-keys', '-t', '=agent-r-agc_17:', '-l', text],
		['send-keys', '-t', '=agent-r-agc_17:', 'Enter'],
	]);
});

test('sendToSpaceAgent never sends Enter when typing the text fails', t => {
	const {runner, sendKeysCalls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		failOn: args => args.includes('-l'),
	});

	t.is(sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner}), 'failed');
	t.false(sendKeysCalls.some(args => args.includes('Enter')));
});

test('sendToSpaceAgent reports no-session and sends nothing when the space has no agent session', t => {
	const {runner, sendKeysCalls} = makeRunner({
		sessions: ['companion-r-STA-1', 'agent-other-STA-1'],
	});

	t.is(sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner}), 'no-session');
	t.deepEqual(sendKeysCalls, []);
});

test('resolveSpaceKey expands a bare number with the team prefix', t => {
	t.is(resolveSpaceKey('696', 'sta', 'linear', []), 'STA-696');
});

test('resolveSpaceKey uppercases a tracker key', t => {
	t.is(resolveSpaceKey('sta-696', 'STA', 'linear', []), 'STA-696');
});

test('resolveSpaceKey lowercases a beads key so it matches the space name', t => {
	t.is(
		resolveSpaceKey('Sausage-Race-AGC.17', 'sausage-race', 'beads', [
			'sausage-race',
		]),
		'sausage-race-agc.17',
	);
});

test('resolveSpaceKey keeps a key outside the tracker grammar as typed', t => {
	t.is(
		resolveSpaceKey(' pappardelle-tqq ', 'STA', 'linear', []),
		'pappardelle-tqq',
	);
});
