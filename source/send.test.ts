// Tests for `pappardelle send` (pappardelle-tqq): resolving a space's agent
// session on the inner socket and submitting a prompt to it.
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {resolveSpaceKey} from './issue-utils.ts';
import {
	resolveInnerSessionTarget,
	sendToSpaceAgent,
	type SendTmuxRunner,
} from './tmux.ts';

const lockDir = mkdtempSync(path.join(tmpdir(), 'pappa-send-test-'));
test.after.always(() => {
	rmSync(lockDir, {recursive: true, force: true});
});

function makeRunner(options: {
	sessions?: string[];
	listFails?: boolean;
	failOn?: (args: readonly string[]) => boolean;
}): {
	runner: SendTmuxRunner;
	calls: string[][];
	inputs: Array<string | undefined>;
} {
	const calls: string[][] = [];
	const inputs: Array<string | undefined> = [];
	const runner: SendTmuxRunner = (args, input) => {
		if (args[0] === 'list-sessions') {
			if (options.listFails) {
				return {status: 1, stdout: ''};
			}

			return {status: 0, stdout: (options.sessions ?? []).join('\n') + '\n'};
		}

		calls.push([...args]);
		inputs.push(input);
		return {status: options.failOn?.(args) ? 1 : 0, stdout: ''};
	};

	return {runner, calls, inputs};
}

test('resolveInnerSessionTarget returns an exact-match session target', async t => {
	const {runner} = makeRunner({sessions: ['agent-r-main', 'agent-r-STA-1']});
	t.is(
		await resolveInnerSessionTarget('agent-r-STA-1', runner),
		'=agent-r-STA-1:',
	);
});

test('resolveInnerSessionTarget does not prefix-match a longer session name', async t => {
	const {runner} = makeRunner({sessions: ['agent-r-STA-12']});
	t.is(await resolveInnerSessionTarget('agent-r-STA-1', runner), null);
});

test('resolveInnerSessionTarget returns null when no inner server is running', async t => {
	const {runner} = makeRunner({listFails: true});
	t.is(await resolveInnerSessionTarget('agent-r-STA-1', runner), null);
});

test('sendToSpaceAgent targets the encoded session of a dotted key, leaves copy-mode, clears the line, pastes the text from stdin as a bracketed paste, then sends Enter as its own call', async t => {
	const text = `-it's "quoted" \`tick\` $HOME\nline two; rm -rf nope`;
	const {runner, calls, inputs} = makeRunner({
		sessions: ['agent-r-agc_17'],
	});

	const buffer = `pappardelle-send-${process.pid}`;

	t.is(
		await sendToSpaceAgent('agc.17', text, {repoName: 'r', runner, lockDir}),
		'sent',
	);
	t.deepEqual(calls, [
		['copy-mode', '-q', '-t', '=agent-r-agc_17:'],
		['send-keys', '-t', '=agent-r-agc_17:', 'C-u'],
		['load-buffer', '-b', buffer, '-'],
		['paste-buffer', '-p', '-d', '-r', '-b', buffer, '-t', '=agent-r-agc_17:'],
		['send-keys', '-t', '=agent-r-agc_17:', 'Enter'],
	]);
	t.deepEqual(inputs, [undefined, undefined, text, undefined, undefined]);
});

test('sendToSpaceAgent stops before pasting or pressing Enter when load-buffer fails', async t => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		failOn: args => args[0] === 'load-buffer',
	});

	t.is(
		await sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner, lockDir}),
		'failed',
	);
	t.is(calls.at(-1)?.[0], 'load-buffer');
});

test('sendToSpaceAgent deletes the loaded buffer and never presses Enter when paste-buffer fails', async t => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		failOn: args => args[0] === 'paste-buffer',
	});

	t.is(
		await sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner, lockDir}),
		'failed',
	);
	t.deepEqual(calls.slice(-2), [
		[
			'paste-buffer',
			'-p',
			'-d',
			'-r',
			'-b',
			`pappardelle-send-${process.pid}`,
			'-t',
			'=agent-r-STA-1:',
		],
		['delete-buffer', '-b', `pappardelle-send-${process.pid}`],
	]);
});

test('sendToSpaceAgent reports no-session and sends nothing when the space has no agent session', async t => {
	const {runner, calls} = makeRunner({
		sessions: ['companion-r-STA-1', 'agent-other-STA-1'],
	});

	t.is(
		await sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner, lockDir}),
		'no-session',
	);
	t.deepEqual(calls, []);
});

test('two sends to one session at once submit one whole prompt after the other', async t => {
	const calls: string[] = [];
	const runner: SendTmuxRunner = async (args, input) => {
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: 'agent-r-STA-1\n'};
		}

		await delay(5);
		calls.push(input ?? args.at(-1) ?? '');
		return {status: 0, stdout: ''};
	};

	await Promise.all([
		sendToSpaceAgent('STA-1', 'first', {repoName: 'r', runner, lockDir}),
		sendToSpaceAgent('STA-1', 'second', {repoName: 'r', runner, lockDir}),
	]);
	const prompts = calls.filter(call => call === 'first' || call === 'second');
	t.deepEqual([...prompts].sort(), ['first', 'second']);
	t.true(calls.indexOf('Enter') < calls.indexOf(prompts[1]!));
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
