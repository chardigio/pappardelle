// Tests for `pappardelle send` (pappardelle-tqq): resolving a space's agent
// session on the inner socket and submitting a prompt to it.
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {resolveSpaceKey} from './issue-utils.ts';
import {
	CLEAR_COMPOSER_ROUNDS,
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
	screen?: string;
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

		if (args[0] === 'capture-pane') {
			return {status: 0, stdout: options.screen ?? ''};
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

test('sendToSpaceAgent targets the encoded session of a dotted key, leaves copy-mode, empties the composer, pastes the text from stdin as a bracketed paste, then sends Enter as its own call', async t => {
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
		[
			'send-keys',
			'-t',
			'=agent-r-agc_17:',
			...Array.from({length: CLEAR_COMPOSER_ROUNDS}, () => [
				'C-e',
				'C-k',
				'C-u',
				'BSpace',
			]).flat(),
		],
		['load-buffer', '-b', buffer, '-'],
		['paste-buffer', '-p', '-d', '-r', '-b', buffer, '-t', '=agent-r-agc_17:'],
		['send-keys', '-t', '=agent-r-agc_17:', 'Enter'],
	]);
	t.deepEqual(inputs, [undefined, undefined, text, undefined, undefined]);
});

test('sendToSpaceAgent leaves a draft in the Codex composer alone unless forced', async t => {
	const draft = '\u001B[1m›\u001B[0m half a thought\n  gpt-6 · ~/repo\n';
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: draft,
	});
	t.is(
		await sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner, lockDir}),
		'draft',
	);
	t.deepEqual(calls, []);
	t.is(
		await sendToSpaceAgent('STA-1', 'hi', {
			repoName: 'r',
			runner,
			lockDir,
			force: true,
		}),
		'sent',
	);
});

test('sendToSpaceAgent never types into a permission prompt, even forced', async t => {
	const prompt = [
		'────────',
		' Bash command',
		' git push',
		' Do you want to proceed?',
		' ❯ 1. Yes',
		'   2. No',
	].join('\n');
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: prompt,
	});
	for (const force of [false, true]) {
		t.is(
			await sendToSpaceAgent('STA-1', '1', {
				repoName: 'r',
				runner,
				lockDir,
				force,
			}),
			'prompt',
		);
	}

	t.deepEqual(calls, []);
});

test('a dim placeholder in the Codex composer is not a draft', async t => {
	const {runner} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: '\u001B[1m›\u001B[0m \u001B[2mAsk Codex to do anything\u001B[0m\n',
	});
	t.is(
		await sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner, lockDir}),
		'sent',
	);
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

test('sendToSpaceAgent reports busy and sends nothing while another live sender holds the lock', async t => {
	const heldDir = mkdtempSync(path.join(tmpdir(), 'pappa-send-held-'));
	t.teardown(() => {
		rmSync(heldDir, {recursive: true, force: true});
	});
	writeFileSync(path.join(heldDir, 'agent-r-STA-1.lock'), `${process.pid}\n`);
	const calls: string[][] = [];
	const runner: SendTmuxRunner = async args => {
		calls.push(args);
		return {
			status: 0,
			stdout: args[0] === 'list-sessions' ? 'agent-r-STA-1\n' : '',
		};
	};
	t.is(
		await sendToSpaceAgent('STA-1', 'hi', {
			repoName: 'r',
			runner,
			lockDir: heldDir,
			lockTimeoutMs: 100,
		}),
		'busy',
	);
	t.deepEqual(
		calls.map(call => call[0]),
		['list-sessions'],
	);
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

/**
 * A composer with the readline keys Claude Code, Codex and agy share: C-e to
 * the line end, C-k to delete to the line end (joining the next line at its
 * end), C-u to delete to the line start, BSpace to delete back (joining the
 * line above at its start).
 */
function composer(lines: string[], row: number, col: number) {
	const text = lines.join('\n');
	let offset =
		lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0) + col;
	let value = text;
	const lineStart = () => value.lastIndexOf('\n', offset - 1) + 1;
	const lineEnd = () => {
		const end = value.indexOf('\n', offset);
		return end === -1 ? value.length : end;
	};

	return {
		press(key: string) {
			switch (key) {
				case 'C-e': {
					offset = lineEnd();
					break;
				}

				case 'C-k': {
					const end = lineEnd() === offset ? offset + 1 : lineEnd();
					value = value.slice(0, offset) + value.slice(end);
					break;
				}

				case 'C-u': {
					const start = lineStart();
					value = value.slice(0, start) + value.slice(offset);
					offset = start;
					break;
				}

				case 'BSpace': {
					if (offset > 0) {
						value = value.slice(0, offset - 1) + value.slice(offset);
						offset--;
					}

					break;
				}

				default: {
					throw new Error(`The composer has no ${key} key`);
				}
			}
		},
		get value() {
			return value;
		},
	};
}

test('the keys sent before a prompt empty a multi-line draft wherever the cursor is', async t => {
	const {runner, calls} = makeRunner({sessions: ['agent-r-STA-1']});
	await sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner, lockDir});
	const clearKeys = calls[1]!.slice(3);
	const draft = Array.from({length: 150}, (_, index) => `draft line ${index}`);
	for (const [row, col] of [
		[0, 0],
		[0, 4],
		[75, 3],
		[149, 13],
	] as const) {
		const box = composer(draft, row, col);
		for (const key of clearKeys) box.press(key);
		t.is(box.value, '', `cursor at line ${row}, column ${col}`);
	}
});
