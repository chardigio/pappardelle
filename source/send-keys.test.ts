import {test, expect, beforeAll, afterAll} from 'bun:test';
import {agentScreenFixture} from '../test/helpers/agent-screens.ts';
import {testTmuxSpaces} from '../test/helpers/state.ts';
import {sendKeysToSpaceAgent, type OuterTmuxRunner} from './tmux.ts';

// tmux.ts names a space's sessions from the stores, as idow recorded them.
const stateTeardowns: Array<() => unknown> = [];
beforeAll(async () => {
	await testTmuxSpaces('repo', ['STA-1'], fn => stateTeardowns.push(fn));
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

function sentKeys(calls: readonly string[][]): Array<string | undefined> {
	return calls.filter(args => args[0] === 'send-keys').map(args => args.at(-1));
}

function agyScreen(footer: string, ...above: string[]): string {
	return [
		...above,
		'────────────────────',
		'\u001B[94m>\u001B[39m',
		'────────────────────',
		`${footer}    auto · Gemini 4 Hydrogen · medium`,
	].join('\n');
}

function recorder(
	sessions: string[],
	failOn?: string,
	screen = '',
	captureStatus = 0,
) {
	const calls: string[][] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'capture-pane')
			return {status: captureStatus, stdout: screen};
		calls.push([...args]);
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: sessions.join('\n') + '\n'};
		return {status: args.at(-1) === failOn ? 1 : 0, stdout: ''};
	};

	return {runner, calls};
}

test('--keys presses each key name in order with no C-u, -l or Enter', () => {
	const {runner, calls} = recorder(['agent-repo-STA-1']);
	expect(
		sendKeysToSpaceAgent('STA-1', ['Escape', 'S-Tab'], {
			runner,
		}),
	).toBe('sent');
	expect(calls.slice(1)).toStrictEqual([
		['send-keys', '-t', '=agent-repo-STA-1:', '--', 'Escape'],
		['send-keys', '-t', '=agent-repo-STA-1:', '--', 'S-Tab'],
	]);
});

test('--keys reports a missing session and stops at a failed key', () => {
	const missing = recorder(['agent-repo-STA-12']);
	expect(
		sendKeysToSpaceAgent('STA-1', ['Escape'], {
			runner: missing.runner,
		}),
	).toBe('no-session');
	const failing = recorder(['agent-repo-STA-1'], 'S-Tab');
	expect(
		sendKeysToSpaceAgent('STA-1', ['S-Tab', 'Enter'], {
			runner: failing.runner,
		}),
	).toBe('failed');
	expect(failing.calls.length).toBe(2);
});

test('--keys never answers a prompt; Escape still declines it', () => {
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
		sendKeysToSpaceAgent('STA-1', keys, {runner, answering});
	expect(press(['1'])).toBe('prompt');
	expect(press(['Enter'])).toBe('prompt');
	expect(press(['Escape'])).toBe('sent');
	expect(press(['1'], true)).toBe('sent');
	expect(sentKeys(calls)).toStrictEqual(['Escape', '1']);
});

test('--keys never touches a Codex dialog, where Escape can quit Codex', () => {
	const trust = [
		'  Do you trust the contents of this directory?',
		'› 1. Yes, continue',
		'  2. No, quit',
		'  enter continue · esc quit',
	].join('\n');
	const {runner} = recorder(['agent-repo-STA-1'], undefined, trust);
	expect(sendKeysToSpaceAgent('STA-1', ['Escape'], {runner})).toBe('prompt');
});

test('--keys presses nothing when it cannot read the screen for a prompt', () => {
	const {runner, calls} = recorder(['agent-repo-STA-1'], undefined, '', 1);
	expect(sendKeysToSpaceAgent('STA-1', ['1'], {runner})).toBe('failed');
	expect(calls.some(args => args[0] === 'send-keys')).toBe(false);
});

test('--keys refuses every key (including Escape) on agy trust dialog, and refuses non-Escape on /artifact review', () => {
	const trust = recorder(
		['agent-repo-STA-1'],
		undefined,
		agentScreenFixture('agy-trust'),
	);
	expect(sendKeysToSpaceAgent('STA-1', ['Enter'], {runner: trust.runner})).toBe(
		'prompt',
	);
	expect(
		sendKeysToSpaceAgent('STA-1', ['Escape'], {runner: trust.runner}),
	).toBe('prompt');
	expect(trust.calls.some(args => args[0] === 'send-keys')).toBe(false);

	const review = recorder(
		['agent-repo-STA-1'],
		undefined,
		agentScreenFixture('agy-plan-artifact-review'),
	);
	expect(sendKeysToSpaceAgent('STA-1', ['y'], {runner: review.runner})).toBe(
		'prompt',
	);
	expect(
		sendKeysToSpaceAgent('STA-1', ['Escape'], {runner: review.runner}),
	).toBe('sent');
	expect(sentKeys(review.calls)).toStrictEqual(['Escape']);
});

test('--keys adapts Escape and S-Tab/BTab for agy vim insert mode and announcement banner without affecting Claude or Codex', () => {
	const send = (screen: string, keys: string[]) => {
		const {runner, calls} = recorder(['agent-repo-STA-1'], undefined, screen);
		const pauses: number[] = [];
		const result = sendKeysToSpaceAgent('STA-1', keys, {
			runner,
			pause: ms => pauses.push(ms),
		});
		return {result, sent: sentKeys(calls), pauses};
	};

	const spinner = '⣾  Running command... 2s';
	const agyWorkingInsert = agyScreen('-- INSERT -- esc to cancel', spinner);
	const agyWorkingNormal = agyScreen('esc to cancel', spinner);
	const agyIdleInsertNoBanner = agyScreen('-- INSERT -- ? for shortcuts');
	const agyFactoryNoBanner = agyScreen('? for shortcuts');

	// Working in vim insert mode: one supervisor Escape sends two with a pause.
	const interrupt = send(agyWorkingInsert, ['Escape']);
	expect(interrupt.result).toBe('sent');
	expect(interrupt.sent).toStrictEqual(['Escape', 'Escape']);
	expect(interrupt.pauses.length).toBe(1);

	// Working with vim insert + announcement banner: S-Tab must NOT send Escape
	// (which would cancel the running turn), only normalize to BTab.
	const agyWorkingInsertWithBanner = agyScreen(
		'-- INSERT -- esc to cancel',
		' ┃ esc to dismiss',
		spinner,
	);
	expect(send(agyWorkingInsertWithBanner, ['S-Tab']).sent).toStrictEqual([
		'BTab',
	]);

	// Idle in vim insert mode or working in vim normal mode: single Escape stays single.
	expect(send(agyIdleInsertNoBanner, ['Escape']).sent).toStrictEqual([
		'Escape',
	]);
	expect(send(agyWorkingNormal, ['Escape']).sent).toStrictEqual(['Escape']);

	// S-Tab / BTab clears vim insert and/or announcement banner first and normalizes S-Tab to BTab.
	expect(send(agyIdleInsertNoBanner, ['S-Tab']).sent).toStrictEqual([
		'Escape',
		'BTab',
	]);
	expect(send(agentScreenFixture('agy-idle'), ['S-Tab']).sent).toStrictEqual([
		'Escape',
		'Escape',
		'BTab',
	]);
	expect(
		send(agentScreenFixture('agy-draft-normal'), ['BTab']).sent,
	).toStrictEqual(['Escape', 'BTab']);
	expect(
		send(agentScreenFixture('agy-idle-factory'), ['S-Tab']).sent,
	).toStrictEqual(['Escape', 'BTab']);
	expect(send(agyFactoryNoBanner, ['S-Tab']).sent).toStrictEqual(['BTab']);
	expect(send(agyIdleInsertNoBanner, ['Escape', 'S-Tab']).sent).toStrictEqual([
		'Escape',
		'BTab',
	]);

	// Claude and Codex screens are untouched.
	expect(
		send(agentScreenFixture('claude-working'), ['Escape']).sent,
	).toStrictEqual(['Escape']);
	expect(send(agentScreenFixture('claude-idle'), ['S-Tab']).sent).toStrictEqual(
		['S-Tab'],
	);
	expect(send(agentScreenFixture('codex-draft'), ['S-Tab']).sent).toStrictEqual(
		['S-Tab'],
	);
});
