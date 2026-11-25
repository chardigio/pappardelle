// Tests for `pappardelle send` (pappardelle-tqq): resolving a space's agent
// session on the inner socket and submitting a prompt to it.
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect, beforeAll, afterAll} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {agentScreenFixture} from '../test/helpers/agent-screens.ts';
import {
	sqliteRun,
	testTmuxSpaces,
	type TestState,
} from '../test/helpers/state.ts';
import {resolveSpaceKey} from './issue-utils.ts';
import {
	CLEAR_COMPOSER_ROUNDS,
	CLEAR_COMPOSER_ROUNDS_PER_CALL,
	resolveInnerSessionTarget,
	sendKeysToSpaceAgent,
	sendToSpaceAgent,
	type SendTmuxRunner,
} from './tmux.ts';

// tmux.ts names a space's sessions from the stores, as idow recorded them.
const stateTeardowns: Array<() => unknown> = [];
let state: TestState;
beforeAll(async () => {
	state = await testTmuxSpaces('r', ['agc.17', 'STA-1'], fn =>
		stateTeardowns.push(fn),
	);
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

const lockDir = mkdtempSync(path.join(tmpdir(), 'pappa-send-test-'));
afterAll(() => {
	rmSync(lockDir, {recursive: true, force: true});
});

function makeRunner(options: {
	sessions?: string[];
	listFails?: boolean;
	failOn?: (args: readonly string[]) => boolean;
	/** The agent's screen, fixed or drawn from what the send has done so far. */
	screen?:
		| string
		| ((sent: {cleared: boolean; pasted: boolean; enters: number}) => string);
	captureFails?: boolean;
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
			const {screen = ''} = options;
			return {
				status: options.captureFails ? 1 : 0,
				stdout:
					typeof screen === 'string'
						? screen
						: screen({
								cleared: calls.some(call => call.includes('C-u')),
								pasted: calls.some(call => call[0] === 'paste-buffer'),
								enters: calls.filter(call => call.at(-1) === 'Enter').length,
							}),
			};
		}

		calls.push([...args]);
		inputs.push(input);
		return {status: options.failOn?.(args) ? 1 : 0, stdout: ''};
	};

	return {runner, calls, inputs};
}

const sleep = async () => {};

/**
 * Codex with an empty input box that shows the pasted text and takes it out
 * on the `submitsOn`th Enter (never, for Infinity), drawing `after` then.
 */
function submitsOnEnter(
	submitsOn: number,
	after = agentScreenFixture('codex-sent'),
): (sent: {cleared: boolean; pasted: boolean; enters: number}) => string {
	return ({pasted, enters}) => {
		if (!pasted) return agentScreenFixture('codex-sent');
		return enters >= submitsOn ? after : agentScreenFixture('codex-draft');
	};
}

test('resolveInnerSessionTarget returns an exact-match session target', async () => {
	const {runner} = makeRunner({sessions: ['agent-r-main', 'agent-r-STA-1']});
	expect(await resolveInnerSessionTarget('agent-r-STA-1', runner)).toBe(
		'=agent-r-STA-1:',
	);
});

test('resolveInnerSessionTarget does not prefix-match a longer session name', async () => {
	const {runner} = makeRunner({sessions: ['agent-r-STA-12']});
	expect(await resolveInnerSessionTarget('agent-r-STA-1', runner)).toBe(null);
});

test('resolveInnerSessionTarget returns null when no inner server is running', async () => {
	const {runner} = makeRunner({listFails: true});
	expect(await resolveInnerSessionTarget('agent-r-STA-1', runner)).toBe(null);
});

test('sendToSpaceAgent targets the encoded session of a dotted key, leaves copy-mode, empties the composer, pastes the text from stdin as a bracketed paste, then sends Enter as its own call', async () => {
	const text = `-it's "quoted" \`tick\` $HOME\nline two; rm -rf nope`;
	const {runner, calls, inputs} = makeRunner({
		sessions: ['agent-r-agc_17'],
	});

	const buffer = `pappardelle-send-${process.pid}`;

	expect(await sendToSpaceAgent('agc.17', text, {runner, lockDir})).toBe(
		'sent',
	);
	expect(calls).toStrictEqual([
		['copy-mode', '-q', '-t', '=agent-r-agc_17:'],
		...Array.from(
			{length: CLEAR_COMPOSER_ROUNDS / CLEAR_COMPOSER_ROUNDS_PER_CALL},
			() => [
				'send-keys',
				'-t',
				'=agent-r-agc_17:',
				...Array.from({length: CLEAR_COMPOSER_ROUNDS_PER_CALL}, () => [
					'C-e',
					'C-k',
					'C-u',
					'BSpace',
				]).flat(),
			],
		),
		['load-buffer', '-b', buffer, '-'],
		['paste-buffer', '-p', '-d', '-r', '-b', buffer, '-t', '=agent-r-agc_17:'],
		['send-keys', '-t', '=agent-r-agc_17:', 'Enter'],
	]);
	expect(inputs.filter(input => input !== undefined).length).toBe(1);
	expect(inputs[calls.findIndex(args => args[0] === 'load-buffer')]).toBe(text);
});

// STA-3087: Claude Code reads one large chunk of keys as a paste. In that paste
// C-k becomes a newline and the prompt then does not submit. 8 rounds (32 keys)
// in one call submitted and 16 rounds failed, so each call stays well under.
test('sendToSpaceAgent sends at most 16 clear keys in each send-keys call, so the agent does not read the clear as a paste', async () => {
	const {runner, calls} = makeRunner({sessions: ['agent-r-STA-1']});
	await sendToSpaceAgent('STA-1', '/context', {runner, lockDir});
	const clears = calls.filter(
		args => args[0] === 'send-keys' && args.at(-1) !== 'Enter',
	);
	expect(clears.length > 1).toBe(true);
	for (const args of clears) expect(args.length - 3 <= 16).toBe(true);
	expect(clears.reduce((sum, args) => sum + args.length - 3, 0)).toBe(
		CLEAR_COMPOSER_ROUNDS * 4,
	);
});

test('sendToSpaceAgent leaves a draft in the Codex composer alone unless forced', async () => {
	const draft = '\u001B[1m›\u001B[0m half a thought\n  gpt-6 · ~/repo\n';
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen(sent) {
			if (sent.pasted) return submitsOnEnter(1)(sent);
			return sent.cleared ? agentScreenFixture('codex-sent') : draft;
		},
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'draft',
	);
	expect(calls).toStrictEqual([]);
	expect(
		await sendToSpaceAgent('STA-1', 'hi', {
			runner,
			lockDir,
			force: true,
			sleep,
		}),
	).toBe('sent');
});

test("sendToSpaceAgent leaves a command typed in Claude's shell mode alone unless forced", async () => {
	const draft = agentScreenFixture('claude-shell-draft');
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen(sent) {
			if (sent.pasted) return submitsOnEnter(1)(sent);
			return sent.cleared ? agentScreenFixture('codex-sent') : draft;
		},
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir})).toBe(
		'draft',
	);
	expect(calls).toStrictEqual([]);
	expect(
		await sendToSpaceAgent('STA-1', 'hi', {
			runner,
			lockDir,
			force: true,
			sleep,
		}),
	).toBe('sent');
});

test('sendToSpaceAgent never types into a permission prompt, even forced', async () => {
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
		expect(
			await sendToSpaceAgent('STA-1', '1', {
				runner,
				lockDir,
				force,
			}),
		).toBe('prompt');
	}

	expect(calls).toStrictEqual([]);
});

test('sendToSpaceAgent sends nothing when it cannot read the screen for a prompt', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		captureFails: true,
	});
	expect(
		await sendToSpaceAgent('STA-1', '1', {repoName: 'r', runner, lockDir}),
	).toBe('failed');
	expect(calls).toStrictEqual([]);
});

test('a dim placeholder in the Codex composer is not a draft', async () => {
	const placeholder =
		'\u001B[1m›\u001B[0m \u001B[2mAsk Codex to do anything\u001B[0m\n';
	const {runner} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: sent => (sent.pasted ? submitsOnEnter(1)(sent) : placeholder),
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'sent',
	);
});

const enters = (calls: string[][]) =>
	calls.filter(args => args.at(-1) === 'Enter').length;

// pappardelle-hrdr: a new Codex session takes the clear keys at about 100 a
// second and draws a paste only after them, seconds later.
test('a send clears the box only when it was not read empty', async () => {
	const clears = async (screen: string) => {
		const {runner, calls} = makeRunner({
			sessions: ['agent-r-STA-1'],
			screen: sent => (sent.pasted ? submitsOnEnter(1)(sent) : screen),
		});
		await sendToSpaceAgent('STA-1', 'hi', {
			runner,
			lockDir,
			sleep,
			force: true,
		});
		return calls.some(args => args.includes('C-u'));
	};

	expect(await clears(agentScreenFixture('codex-sent'))).toBe(false);
	expect(await clears(agentScreenFixture('codex-draft'))).toBe(true);
	expect(await clears('$ ')).toBe(true);
});

test('a send presses Enter once the agent shows the pasted text, and is sent when the box empties', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: submitsOnEnter(1),
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'sent',
	);
	expect(enters(calls)).toBe(1);
});

// pappardelle-hrdr: Codex has left a sent prompt in its box until the next key.
test('a forced send pastes only once the cleared box reads empty', async () => {
	const draft = '\u001B[1m›\u001B[0m half a thought\n  gpt-6 · ~/repo\n';
	let readsAfterClear = 0;
	let pastedEarly = false;
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen(sent) {
			if (!sent.cleared) return draft;
			if (sent.pasted) return submitsOnEnter(1)(sent);
			readsAfterClear++;
			return readsAfterClear <= 5 ? draft : agentScreenFixture('codex-sent');
		},
	});
	const result = await sendToSpaceAgent('STA-1', 'hi', {
		async runner(args, input) {
			if (args[0] === 'paste-buffer' && readsAfterClear <= 5)
				pastedEarly = true;
			return runner(args, input);
		},
		lockDir,
		sleep,
		force: true,
	});
	expect(result).toBe('sent');
	expect(pastedEarly).toBe(false);
	expect(enters(calls)).toBe(1);
});

// The draft left by an unsubmitted send, sent again with --force.
test('a forced send of the same text as the draft is sent', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen(sent) {
			if (!sent.cleared || sent.pasted)
				return submitsOnEnter(1)({...sent, pasted: true});
			return agentScreenFixture('codex-sent');
		},
	});
	expect(
		await sendToSpaceAgent('STA-1', 'a draft I have not sent yet', {
			runner,
			lockDir,
			sleep,
			force: true,
		}),
	).toBe('sent');
	expect(enters(calls)).toBe(1);
});

// Clearing the box is what takes Claude out of shell mode; pasted into it, the
// prompt would run as a shell command.
test("a send clears Claude's empty shell-mode box, so the prompt is not run as a command", async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen(sent) {
			if (!sent.cleared) return agentScreenFixture('claude-shell-empty');
			return sent.pasted
				? submitsOnEnter(1)(sent)
				: agentScreenFixture('claude-placeholder');
		},
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'sent',
	);
	expect(calls.some(args => args.includes('C-u'))).toBe(true);
});

test('a send presses Enter again when the first leaves the text in the box', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: submitsOnEnter(2),
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'sent',
	);
	expect(enters(calls)).toBe(2);
});

test('a send whose text stays in the box after two Enters is unsubmitted', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: submitsOnEnter(Number.POSITIVE_INFINITY),
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'unsubmitted',
	);
	expect(enters(calls)).toBe(2);
});

test('a send presses no Enter when the pasted text never shows in the box', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: agentScreenFixture('codex-sent'),
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'failed',
	);
	expect(enters(calls)).toBe(0);
});

test('a send presses nothing more when a dialog replaces the box before the paste shows', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: sent =>
			sent.pasted
				? agentScreenFixture('claude-permission-bash')
				: agentScreenFixture('claude-placeholder'),
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'failed',
	);
	expect(enters(calls)).toBe(0);
});

test('a permission prompt that opens after the Enter means the text was sent, and gets no second Enter', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: submitsOnEnter(1, agentScreenFixture('claude-permission-bash')),
	});
	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep})).toBe(
		'sent',
	);
	expect(enters(calls)).toBe(1);
});

test('an agent whose input box is not read gets the paste and one Enter, unwatched', async () => {
	let reads = 0;
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: '$ ',
	});
	expect(
		await sendToSpaceAgent('STA-1', 'hi', {
			async runner(args, input) {
				if (args[0] === 'capture-pane') reads++;
				return runner(args, input);
			},
			lockDir,
			sleep,
		}),
	).toBe('sent');
	expect(enters(calls)).toBe(1);
	expect(reads).toBe(1);
});

test('sendToSpaceAgent stops before pasting or pressing Enter when load-buffer fails', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		failOn: args => args[0] === 'load-buffer',
	});

	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir})).toBe(
		'failed',
	);
	expect(calls.at(-1)?.[0]).toBe('load-buffer');
});

test('sendToSpaceAgent deletes the loaded buffer and never presses Enter when paste-buffer fails', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		failOn: args => args[0] === 'paste-buffer',
	});

	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir})).toBe(
		'failed',
	);
	expect(calls.slice(-2)).toStrictEqual([
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

test('sendToSpaceAgent reports no-session and sends nothing when the space has no agent session', async () => {
	const {runner, calls} = makeRunner({
		sessions: ['companion-r-STA-1', 'agent-other-STA-1'],
	});

	expect(await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir})).toBe(
		'no-session',
	);
	expect(calls).toStrictEqual([]);
});

test('two sends to one session at once submit one whole prompt after the other', async () => {
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
		sendToSpaceAgent('STA-1', 'first', {runner, lockDir}),
		sendToSpaceAgent('STA-1', 'second', {runner, lockDir}),
	]);
	const prompts = calls.filter(call => call === 'first' || call === 'second');
	expect([...prompts].sort()).toStrictEqual(['first', 'second']);
	expect(calls.indexOf('Enter') < calls.indexOf(prompts[1]!)).toBe(true);
});

test('sendToSpaceAgent reports busy and sends nothing while another live sender holds the lock', async () => {
	const heldDir = mkdtempSync(path.join(tmpdir(), 'pappa-send-held-'));
	teardown(() => {
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
	expect(
		await sendToSpaceAgent('STA-1', 'hi', {
			runner,
			lockDir: heldDir,
			lockTimeoutMs: 100,
		}),
	).toBe('busy');
	expect(calls.map(call => call[0])).toStrictEqual(['list-sessions']);
});

test('resolveSpaceKey expands a bare number with the team prefix', () => {
	expect(resolveSpaceKey('696', 'sta', 'linear', [])).toBe('STA-696');
});

test('resolveSpaceKey uppercases a tracker key', () => {
	expect(resolveSpaceKey('sta-696', 'STA', 'linear', [])).toBe('STA-696');
});

test('resolveSpaceKey lowercases a beads key so it matches the space name', () => {
	expect(
		resolveSpaceKey('Sausage-Race-AGC.17', 'sausage-race', 'beads', [
			'sausage-race',
		]),
	).toBe('sausage-race-agc.17');
});

test('resolveSpaceKey keeps a key outside the tracker grammar as typed', () => {
	expect(resolveSpaceKey(' pappardelle-tqq ', 'STA', 'linear', [])).toBe(
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

test('the keys sent before a prompt empty a multi-line draft wherever the cursor is', async () => {
	const {runner, calls} = makeRunner({sessions: ['agent-r-STA-1']});
	await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir});
	const clearKeys = calls
		.filter(args => args[0] === 'send-keys' && args.at(-1) !== 'Enter')
		.flatMap(args => args.slice(3));
	const draft = Array.from({length: 150}, (_, index) => `draft line ${index}`);
	for (const [row, col] of [
		[0, 0],
		[0, 4],
		[75, 3],
		[149, 13],
	] as const) {
		const box = composer(draft, row, col);
		for (const key of clearKeys) box.press(key);
		expect(box.value, `cursor at line ${row}, column ${col}`).toBe('');
	}
});

if (sqliteRun) {
	test('sendToSpaceAgent sends to the agent session stored for the space', async () => {
		await state.daos.spaceIdentities.record({
			repo: 'r',
			key: 'HAND-1',
			worktreePath: '/w/HAND-1',
			tmux: {
				socket: 'pappardelle_inner',
				agentSession: 'hand-named-agent',
				companionSession: 'hand-named-companion',
			},
		});
		const {runner, calls} = makeRunner({
			sessions: ['hand-named-agent', 'agent-r-HAND-1'],
		});
		expect(await sendToSpaceAgent('HAND-1', 'hi', {runner, lockDir})).toBe(
			'sent',
		);
		expect(calls.find(args => args[0] === 'paste-buffer')?.at(-1)).toBe(
			'=hand-named-agent:',
		);
		expect(calls.some(args => args.includes('=agent-r-HAND-1:'))).toBe(false);
	});
}

test('sendToSpaceAgent leaves an agy draft alone unless forced, and never sends i in insert or factory mode', async () => {
	for (const name of ['agy-draft', 'agy-draft-normal', 'agy-draft-factory']) {
		const {runner, calls} = makeRunner({
			sessions: ['agent-r-STA-1'],
			screen: agentScreenFixture(name),
		});
		expect(
			await sendToSpaceAgent('STA-1', 'hi', {runner, lockDir, sleep}),
		).toBe('draft');
		expect(calls).toStrictEqual([]);
	}

	const sentAgy = (enters: number) =>
		enters >= 1
			? agentScreenFixture('agy-idle')
			: agentScreenFixture('agy-draft');
	for (const name of ['agy-draft', 'agy-draft-factory']) {
		const {runner, calls} = makeRunner({
			sessions: ['agent-r-STA-1'],
			screen(sent) {
				if (sent.pasted) return sentAgy(sent.enters);
				return sent.cleared
					? agentScreenFixture('agy-idle')
					: agentScreenFixture(name);
			},
		});
		expect(
			await sendToSpaceAgent('STA-1', 'hi', {
				runner,
				lockDir,
				force: true,
				sleep,
			}),
		).toBe('sent');
		expect(
			calls.some(args => args[0] === 'send-keys' && args.at(-1) === 'i'),
		).toBe(false);
	}
});

test('forced send over an agy vim normal-mode draft enters insert mode once the first clear leaves it, then clears and submits', async () => {
	let enteredInsert = false;
	const {runner, calls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen(sent) {
			if (sent.pasted) {
				return sent.enters >= 1
					? agentScreenFixture('agy-idle')
					: agentScreenFixture('agy-draft');
			}

			if (enteredInsert) return agentScreenFixture('agy-idle');
			return agentScreenFixture('agy-draft-normal');
		},
	});
	const wrappedRunner: SendTmuxRunner = async (args, input) => {
		if (args[0] === 'send-keys' && args.at(-1) === 'i') {
			enteredInsert = true;
		}

		return runner(args, input);
	};

	expect(
		await sendToSpaceAgent('STA-1', 'hi', {
			runner: wrappedRunner,
			lockDir,
			force: true,
			sleep,
		}),
	).toBe('sent');
	expect(enteredInsert).toBe(true);
	const insertAt = calls.findIndex(
		args => args[0] === 'send-keys' && args.at(-1) === 'i',
	);
	expect(insertAt > 0).toBe(true);
	expect(calls.slice(insertAt + 1).some(args => args.includes('C-u'))).toBe(
		true,
	);
	expect(calls.at(-1)?.at(-1)).toBe('Enter');
});

test('sendKeysToSpaceAgent allows Escape on an agy question and refuses answer keys', () => {
	const calls: string[][] = [];
	const runner = (args: readonly string[]) => {
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: 'agent-r-STA-1\n'};
		if (args[0] === 'capture-pane')
			return {status: 0, stdout: agentScreenFixture('agy-question')};
		calls.push([...args]);
		return {status: 0, stdout: ''};
	};

	expect(sendKeysToSpaceAgent('STA-1', ['1'], {runner})).toBe('prompt');
	expect(sendKeysToSpaceAgent('STA-1', ['Enter'], {runner})).toBe('prompt');
	expect(calls).toStrictEqual([]);
	expect(sendKeysToSpaceAgent('STA-1', ['Escape'], {runner})).toBe('sent');
	expect(calls).toStrictEqual([
		['send-keys', '-t', '=agent-r-STA-1:', '--', 'Escape'],
	]);
});

test('sendToSpaceAgent and sendKeysToSpaceAgent block on agy subagent manage view without mislabeling codexDialog', async () => {
	const {runner: sendRunner, calls: sendCalls} = makeRunner({
		sessions: ['agent-r-STA-1'],
		screen: agentScreenFixture('agy-subagent-manage'),
	});
	expect(
		await sendToSpaceAgent('STA-1', 'hi', {runner: sendRunner, lockDir, sleep}),
	).toBe('prompt');
	expect(
		await sendToSpaceAgent('STA-1', 'hi', {
			runner: sendRunner,
			lockDir,
			force: true,
			sleep,
		}),
	).toBe('prompt');
	expect(sendCalls).toStrictEqual([]);

	const keyCalls: string[][] = [];
	const keyRunner = (args: readonly string[]) => {
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: 'agent-r-STA-1\n'};
		if (args[0] === 'capture-pane')
			return {status: 0, stdout: agentScreenFixture('agy-subagent-manage')};
		keyCalls.push([...args]);
		return {status: 0, stdout: ''};
	};

	expect(sendKeysToSpaceAgent('STA-1', ['Enter'], {runner: keyRunner})).toBe(
		'prompt',
	);
	expect(sendKeysToSpaceAgent('STA-1', ['1'], {runner: keyRunner})).toBe(
		'prompt',
	);
	expect(keyCalls).toStrictEqual([]);
	expect(sendKeysToSpaceAgent('STA-1', ['Escape'], {runner: keyRunner})).toBe(
		'sent',
	);
	expect(keyCalls).toStrictEqual([
		['send-keys', '-t', '=agent-r-STA-1:', '--', 'Escape'],
	]);
});
