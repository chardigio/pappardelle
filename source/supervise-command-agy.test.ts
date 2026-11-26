import {test, expect} from 'bun:test';
import {agentScreenFixture as fixture} from '../test/helpers/agent-screens.ts';
import {testState} from '../test/helpers/state.ts';
import {superviseDeps} from '../test/helpers/supervise-deps.ts';
import {unreachable} from '../test/helpers/unreachable.ts';
import type {ApprovalPolicy} from './approve-policy.ts';
import {runSuperviseCommand, type SuperviseDeps} from './supervise-command.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const NOW = new Date(2026, 10, 9, 12, 0);

const policy: ApprovalPolicy = {
	worktree: '/worktree',
	roots: ['/tmp'],
	reserved: [],
	shared: [],
	scratchpad: '-worktree',
	defaultBranch: 'main',
	realpath: target => target,
};

function agyHarness(
	screens: string[],
	{
		readAgyQuota,
		sendOutcome = 'sent',
	}: {
		readAgyQuota?: SuperviseDeps['readAgyQuota'];
		sendOutcome?: Awaited<ReturnType<SuperviseDeps['send']>>;
	} = {},
) {
	const {schedules, holds} = testState().daos;
	const pressed: string[][] = [];
	const classified: string[] = [];
	const sent: Array<{key: string; text: string}> = [];
	let clock = NOW.getTime();
	let reads = 0;
	let redraws = 0;
	let ids = 0;
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: 'agent-repo-STA-1\n'};
		}

		if (args[0] === 'capture-pane') {
			if (redraws > 0) {
				redraws--;
				return {status: 0, stdout: fixture('agy-idle')};
			}

			return {
				status: 0,
				stdout: screens[Math.min(reads++, screens.length - 1)]!,
			};
		}

		return {status: 1, stdout: ''};
	};

	const {deps, logged, out, err} = superviseDeps({
		readHookState: async () => ({kind: 'none'}),
		readSnapshot: async () => null,
		...(readAgyQuota ? {readAgyQuota} : {}),
		runner,
		now: () => new Date(clock),
		async sleep(ms) {
			clock += ms;
		},
		async waitForStatusChange(ms) {
			clock += ms;
		},
		async send(key, text) {
			sent.push({key, text});
			return sendOutcome;
		},
		async sendKeys(_key, keys) {
			pressed.push(keys);
			redraws = 1;
			return 'sent';
		},
		async classify(_key, request) {
			classified.push(request.command);
			return {kind: 'approve', reason: 'safe'};
		},
		policy: () => policy,
		store: () => schedules,
		holds: () => holds,
		newHoldId: () => `h${++ids}`,
		timers: () => ({
			create() {},
			remove() {},
			exists: () => unreachable('exists is not stubbed'),
		}),
	});
	return {
		schedules,
		holds,
		pressed,
		classified,
		sent,
		logged,
		out,
		err,
		run: async (...argv: string[]) => runSuperviseCommand(argv, deps),
	};
}

test('agy MCP prompt with no visible call line holds as cutOff instead of calling classifier', async () => {
	const bareMcp = [
		'MCP',
		'────────────────────────────────────────',
		'',
		'qastub/qa_echo',
		'',
		'Allow calling this tool?',
		'> 1. Yes, allow tool call',
		'  2. No, deny tool call',
		'',
		'  ↑/↓ Navigate · tab Amend',
		'esc to cancel    auto · Gemini 4 Hydrogen · medium',
	].join('\n');
	const h = agyHarness([bareMcp]);
	expect(await h.run('answer', 'STA-1', '--option', '1')).toBe(0);
	expect(h.classified).toStrictEqual([]);
	expect(h.pressed).toStrictEqual([['2']]);
	expect(h.holds.load('h1')).toMatchObject({
		tool: 'MCP',
		approvable: false,
	});
});

test('agy Models & Quota panel supports after_limit, stale refresh, Escape dismissal on fire, and deferred wake-up visibility', async () => {
	const exhausted = agyHarness([fixture('agy-quota-panel-exhausted')]);
	expect(await exhausted.run('state', 'STA-1')).toBe(0);
	expect(exhausted.out[0]).toBe(
		'STA-1: usage_limit\nUsage limit resets Refreshes in 4h 58m\nDialog: Models & Quota (/quota)',
	);
	expect(await exhausted.run('schedule', 'STA-1', '--after-limit')).toBe(0);
	expect(exhausted.schedules.list()[0]).toMatchObject({
		kind: 'after_limit',
		at: new Date(NOW.getTime() + (4 * 60 + 59) * 60_000).toISOString(),
	});

	// Stale exhausted panel after window resets: fresh /quota says available,
	// so `fire` clears the stale limit, presses Escape to close the panel, and sends `continue`.
	const reset = agyHarness([fixture('agy-quota-panel-exhausted')], {
		readAgyQuota: async () => ({kind: 'available'}),
	});
	await reset.schedules.save({
		kind: 'after_limit',
		id: 'al-q',
		key: 'STA-1',
		at: NOW.toISOString(),
		message: 'continue',
		arm: 0,
	});
	expect(await reset.run('schedule', 'fire', 'al-q')).toBe(0);
	expect(reset.pressed).toStrictEqual([['Escape']]);
	expect(reset.sent).toStrictEqual([{key: 'STA-1', text: 'continue'}]);
	expect(reset.schedules.list()).toStrictEqual([]);

	// Healthy open Models & Quota panel: `at` job dismisses it with Escape and delivers.
	const healthy = agyHarness([fixture('agy-quota-panel')]);
	await healthy.schedules.save({
		kind: 'at',
		id: 'at-q',
		key: 'STA-1',
		at: NOW.toISOString(),
		message: 'check status',
		arm: 0,
	});
	expect(await healthy.run('schedule', 'fire', 'at-q')).toBe(0);
	expect(healthy.pressed).toStrictEqual([['Escape']]);
	expect(healthy.sent).toStrictEqual([{key: 'STA-1', text: 'check status'}]);
	expect(
		healthy.logged.some(
			entry =>
				entry.action === 'answer' &&
				entry.detail?.includes('closed Models & Quota panel'),
		),
	).toBe(true);

	// Deferred `at` job surfaces in schedules, supervise.jsonl, state, and watch.
	const deferred = agyHarness([fixture('agy-config'), fixture('agy-config')], {
		sendOutcome: 'prompt',
	});
	await deferred.schedules.save({
		kind: 'at',
		id: 'at-def',
		key: 'STA-1',
		at: NOW.toISOString(),
		message: 'ping',
		arm: 0,
	});
	expect(await deferred.run('schedule', 'fire', 'at-def')).toBe(0);
	expect(
		deferred.logged.some(
			entry =>
				entry.action === 'fire' &&
				entry.detail?.includes('retrying (prompt, state: dialog)'),
		),
	).toBe(true);
	expect(await deferred.run('schedules', 'STA-1')).toBe(0);
	expect(deferred.out.at(-1)).toContain('[deferred 1x: prompt]');
	expect(await deferred.run('state', 'STA-1')).toBe(0);
	expect(deferred.out.at(-1)).toContain('Deferred wake-up: at-def (1x: prompt');

	// Watching a space that was already in `draft` still wakes when its at-job defers.
	const watched = agyHarness([fixture('agy-draft'), fixture('agy-draft')]);
	expect(await watched.run('watch', 'STA-1', '--timeout', '1')).toBe(0);
	const cursor = /Cursor: (\S+)/.exec(watched.out.at(-1) ?? '')?.[1] ?? '';
	await watched.schedules.save({
		kind: 'at',
		id: 'at-w',
		key: 'STA-1',
		at: NOW.toISOString(),
		message: 'resume',
		arm: 1,
		deferReason: 'draft',
		deferCount: 1,
	});
	expect(
		await watched.run(
			'watch',
			'STA-1',
			'--until',
			'blocked',
			'--since',
			cursor,
			'--timeout',
			'1',
		),
	).toBe(0);
	expect(watched.out.at(-1)).toContain('Deferred wake-up: at-w (1x: draft');
});
