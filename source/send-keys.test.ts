import {test, expect, beforeAll, afterAll} from 'bun:test';
import {agentScreenFixture} from '../test/helpers/agent-screens.ts';
import {snapshotOf} from '../test/helpers/program-status.ts';
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
		if (args[0] === 'list-panes') return {status: 1, stdout: ''};
		calls.push([...args]);
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: sessions.join('\n') + '\n'};
		return {status: args.at(-1) === failOn ? 1 : 0, stdout: ''};
	};

	return {runner, calls};
}

test('--keys presses each key name in order with no C-u, -l or Enter', async () => {
	const {runner, calls} = recorder(['agent-repo-STA-1']);
	expect(
		await sendKeysToSpaceAgent('STA-1', ['Escape', 'S-Tab'], {
			runner,
		}),
	).toBe('sent');
	expect(calls.slice(1)).toStrictEqual([
		['send-keys', '-t', '=agent-repo-STA-1:', '--', 'Escape'],
		['send-keys', '-t', '=agent-repo-STA-1:', '--', 'S-Tab'],
	]);
});

test('--keys reports a missing session and stops at a failed key', async () => {
	const missing = recorder(['agent-repo-STA-12']);
	expect(
		await sendKeysToSpaceAgent('STA-1', ['Escape'], {
			runner: missing.runner,
		}),
	).toBe('no-session');
	const failing = recorder(['agent-repo-STA-1'], 'S-Tab');
	expect(
		await sendKeysToSpaceAgent('STA-1', ['S-Tab', 'Enter'], {
			runner: failing.runner,
		}),
	).toBe('failed');
	expect(failing.calls.length).toBe(2);
});

test('--keys never answers a prompt; Escape still declines it', async () => {
	const prompt = [
		'────────',
		' Bash command',
		' rm -rf /home/u',
		' Do you want to proceed?',
		' ❯ 1. Yes',
		'   2. No',
	].join('\n');
	const {runner, calls} = recorder(['agent-repo-STA-1'], undefined, prompt);
	const press = async (keys: string[], answering = false) =>
		sendKeysToSpaceAgent('STA-1', keys, {runner, answering});
	expect(await press(['1'])).toBe('prompt');
	expect(await press(['Enter'])).toBe('prompt');
	expect(await press(['Escape'])).toBe('sent');
	expect(await press(['1'], true)).toBe('sent');
	expect(sentKeys(calls)).toStrictEqual(['Escape', '1']);
});

test('--keys never touches a Codex dialog, where Escape can quit Codex', async () => {
	const trust = [
		'  Do you trust the contents of this directory?',
		'› 1. Yes, continue',
		'  2. No, quit',
		'  enter continue · esc quit',
	].join('\n');
	const {runner} = recorder(['agent-repo-STA-1'], undefined, trust);
	expect(await sendKeysToSpaceAgent('STA-1', ['Escape'], {runner})).toBe(
		'prompt',
	);
});

test('--keys presses nothing when it cannot read the screen for a prompt', async () => {
	const {runner, calls} = recorder(['agent-repo-STA-1'], undefined, '', 1);
	expect(await sendKeysToSpaceAgent('STA-1', ['1'], {runner})).toBe('failed');
	expect(calls.some(args => args[0] === 'send-keys')).toBe(false);
});

test('--keys refuses every key (including Escape) on agy trust dialog, and refuses non-Escape on /artifact review', async () => {
	const trust = recorder(
		['agent-repo-STA-1'],
		undefined,
		agentScreenFixture('agy-trust'),
	);
	expect(
		await sendKeysToSpaceAgent('STA-1', ['Enter'], {runner: trust.runner}),
	).toBe('prompt');
	expect(
		await sendKeysToSpaceAgent('STA-1', ['Escape'], {runner: trust.runner}),
	).toBe('prompt');
	expect(trust.calls.some(args => args[0] === 'send-keys')).toBe(false);

	const review = recorder(
		['agent-repo-STA-1'],
		undefined,
		agentScreenFixture('agy-plan-artifact-review'),
	);
	expect(
		await sendKeysToSpaceAgent('STA-1', ['y'], {runner: review.runner}),
	).toBe('prompt');
	expect(
		await sendKeysToSpaceAgent('STA-1', ['Escape'], {runner: review.runner}),
	).toBe('sent');
	expect(sentKeys(review.calls)).toStrictEqual(['Escape']);
});

test('--keys adapts Escape and S-Tab/BTab for agy vim insert mode and announcement banner without affecting Claude or Codex', async () => {
	const send = async (screen: string, keys: string[]) => {
		const {runner, calls} = recorder(['agent-repo-STA-1'], undefined, screen);
		const pauses: number[] = [];
		const result = await sendKeysToSpaceAgent('STA-1', keys, {
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

	const sentFor = async (screen: string, keys: string[]) => {
		const outcome = await send(screen, keys);
		return outcome.sent;
	};

	// Working in vim insert mode: one supervisor Escape sends two with a pause.
	const interrupt = await send(agyWorkingInsert, ['Escape']);
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
	expect(await sentFor(agyWorkingInsertWithBanner, ['S-Tab'])).toStrictEqual([
		'BTab',
	]);

	// Idle in vim insert mode or working in vim normal mode: single Escape stays single.
	expect(await sentFor(agyIdleInsertNoBanner, ['Escape'])).toStrictEqual([
		'Escape',
	]);
	expect(await sentFor(agyWorkingNormal, ['Escape'])).toStrictEqual([
		'Escape',
	]);

	// S-Tab / BTab clears vim insert and/or announcement banner first and normalizes S-Tab to BTab.
	expect(await sentFor(agyIdleInsertNoBanner, ['S-Tab'])).toStrictEqual([
		'Escape',
		'BTab',
	]);
	expect(
		await sentFor(agentScreenFixture('agy-idle'), ['S-Tab']),
	).toStrictEqual(['Escape', 'Escape', 'BTab']);
	expect(
		await sentFor(agentScreenFixture('agy-draft-normal'), ['BTab']),
	).toStrictEqual(['Escape', 'BTab']);
	expect(
		await sentFor(agentScreenFixture('agy-idle-factory'), ['S-Tab']),
	).toStrictEqual(['Escape', 'BTab']);
	expect(await sentFor(agyFactoryNoBanner, ['S-Tab'])).toStrictEqual(['BTab']);
	expect(
		await sentFor(agyIdleInsertNoBanner, ['Escape', 'S-Tab']),
	).toStrictEqual(['Escape', 'BTab']);

	// Claude and Codex screens are untouched.
	expect(
		await sentFor(agentScreenFixture('claude-working'), ['Escape']),
	).toStrictEqual(['Escape']);
	expect(
		await sentFor(agentScreenFixture('claude-idle'), ['S-Tab']),
	).toStrictEqual(['S-Tab']);
	expect(
		await sentFor(agentScreenFixture('codex-draft'), ['S-Tab']),
	).toStrictEqual(['S-Tab']);
});

test('--keys blocks non-Escape on agy prompts, /model, /config and unparsed OSC blocked prompts, while allowing Approve plan artifactReview', async () => {
	for (const name of [
		'agy-permission-shell',
		'agy-config',
		'agy-model-picker',
		'agy-subagent-banner-1',
	] as const) {
		const {runner, calls} = recorder(
			['agent-repo-STA-1'],
			undefined,
			agentScreenFixture(name),
		);
		expect(await sendKeysToSpaceAgent('STA-1', ['1'], {runner}), name).toBe(
			'prompt',
		);
		expect(await sendKeysToSpaceAgent('STA-1', ['Enter'], {runner}), name).toBe(
			'prompt',
		);
		expect(calls.some(args => args[0] === 'send-keys')).toBe(false);
		expect(
			await sendKeysToSpaceAgent('STA-1', ['Escape'], {runner}),
			name,
		).toBe('sent');
	}

	const paneListing = '11\t%1\t%1\t42\t0\t1\t42.marker\n';
	const makeOscRunner =
		(screen: string): OuterTmuxRunner =>
		args => {
			if (args[0] === 'list-sessions')
				return {status: 0, stdout: 'agent-repo-STA-1\n'};
			if (args[0] === 'list-panes') return {status: 0, stdout: paneListing};
			if (args[0] === 'capture-pane') return {status: 0, stdout: screen};
			return {status: 0, stdout: ''};
		};

	const blockedSnapshot = async (message: string, authoritative = true) =>
		snapshotOf(
			{
				repo: 'repo',
				key: 'STA-1',
				pane: {
					id: '%1',
					pid: '42',
					dead: false,
					piped: true,
					marker: '42.marker',
					generation: 'gen',
				},
			},
			[
				{
					state: 'blocked',
					id: '',
					app: 'antigravity',
					kind: 'permission',
					message,
				},
			],
			{authoritative},
		);

	expect(
		await sendKeysToSpaceAgent('STA-1', ['1'], {
			runner: makeOscRunner('unparsed custom agy modal'),
			readSnapshot: async () => blockedSnapshot('Approve CustomTool'),
		}),
	).toBe('prompt');
	expect(
		await sendKeysToSpaceAgent('STA-1', ['1'], {
			runner: makeOscRunner('unparsed custom agy modal'),
			readSnapshot: async () => blockedSnapshot('Approve CustomTool', false),
		}),
	).toBe('sent');
	expect(
		await sendKeysToSpaceAgent('STA-1', ['Escape'], {
			runner: makeOscRunner('unparsed custom agy modal'),
			readSnapshot: async () => blockedSnapshot('Approve CustomTool'),
		}),
	).toBe('sent');

	// Non-modal `Approve plan` artifact banner stays open to non-Escape keys.
	expect(
		await sendKeysToSpaceAgent('STA-1', ['C-l'], {
			runner: makeOscRunner(agentScreenFixture('agy-plan-approval')),
			readSnapshot: async () => blockedSnapshot('Approve plan'),
		}),
	).toBe('sent');

	// Answering a subagent banner with Escape + C-k pauses between keys.
	const pauses: number[] = [];
	const sub = recorder(['agent-repo-STA-1']);
	expect(
		await sendKeysToSpaceAgent('STA-1', ['Escape', 'C-k'], {
			runner: sub.runner,
			answering: true,
			pause: ms => pauses.push(ms),
		}),
	).toBe('sent');
	expect(pauses.length).toBe(1);
});
