import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {publishSnapshot, snapshotOf} from '../test/helpers/program-status.ts';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {parseStatusPane} from './program-status-monitor.ts';
import {
	createAgyQuotaReader,
	defaultSuperviseDeps,
	sanitizedAgyEnv,
} from './supervise-runtime.ts';

test('a supervised wait ends early when a hook status or a native status changes', async () => {
	const state = testState();
	const deps = defaultSuperviseDeps(raw => raw, state.daos);
	const waited = async (ms: number, change?: () => Promise<void> | void) => {
		const started = performance.now();
		const waiting = deps.waitForStatusChange(ms);
		await delay(50);
		await change?.();
		await waiting;
		return performance.now() - started;
	};

	// Before any write: macOS can report a write after a later wait began.
	expect((await waited(200)) >= 190).toBe(true);
	expect(
		(await waited(3000, async () =>
			writeClaudeStatus(state, {
				sessionId: 'session',
				workspaceName: 'repo-STA-1',
				status: 'waiting_for_approval',
				lastUpdate: Date.now(),
			}),
		)) < 2000,
	).toBe(true);
	expect(
		(await waited(3000, async () =>
			publishSnapshot(
				state,
				snapshotOf(
					{
						repo: 'repo',
						key: 'STA-1',
						pane: parseStatusPane('%1\t12\t0\t1\t12.owner', 'test-status')!,
					},
					[{state: 'working', id: ''}],
				),
			),
		)) < 2000,
	).toBe(true);
});

test('createAgyQuotaReader strips PAPPARDELLE_* and TMUX*, forwards env/tilde/model, and caches both ok and error results for TTL', async () => {
	expect(
		sanitizedAgyEnv({
			PATH: '/usr/bin',
			HOME: '/home/u',
			PAPPARDELLE_SPACE: 'STA-1',
			PAPPARDELLE_REPO: 'repo',
			TMUX: '/tmp/tmux-1000/default,1,0',
			TMUX_PANE: '%1',
			TMUX_TMPDIR: '/tmp',
		}),
	).toStrictEqual({PATH: '/usr/bin', HOME: '/home/u'});

	let clock = new Date('2026-11-24T08:00:00Z').getTime();
	const calls: Array<{
		command: string;
		args: readonly string[];
		env: NodeJS.ProcessEnv;
	}> = [];
	let result: {kind: 'ok'; output: string} | {kind: 'error'} = {
		kind: 'ok',
		output: [
			'Gemini Models\tFive Hour Limit Remaining\t56%\t2026-11-24T09:10:11Z',
			'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-24T09:10:11Z',
		].join('\n'),
	};
	const reader = createAgyQuotaReader({
		now: () => new Date(clock),
		env: {
			HOME: '/home/qa',
			PATH: '/bin',
			PAPPARDELLE_SPACE: 'STA-1',
			TMUX: 'x',
			DROP_ME: '1',
		},
		cacheTtlMs: 60_000,
		async run(command, args, opts) {
			calls.push({command, args, env: opts.env});
			return result;
		},
	});

	// Cache is shared per resolved launch/env, while model filters the parsed buckets.
	const gemini = await reader('~/bin/agy', {
		env: {FOO: 'bar'},
		unset: ['DROP_ME'],
		model: 'gemini-4-hydrogen-medium',
	});
	expect(gemini).toStrictEqual({kind: 'available'});
	expect(calls[0]!.command).toBe('/home/qa/bin/agy');
	expect(calls[0]!.args).toStrictEqual(['-p', '/quota']);
	expect(calls[0]!.env).toStrictEqual({
		HOME: '/home/qa',
		PATH: '/bin',
		FOO: 'bar',
	});

	clock += 30_000;
	const claude = await reader('~/bin/agy', {
		env: {FOO: 'bar'},
		unset: ['DROP_ME'],
		model: 'claude-sonnet-4-6',
	});
	expect(calls.length).toBe(1);
	expect(claude).toStrictEqual({
		kind: 'limited',
		limit: {
			resetText: '2026-11-24T09:10:11Z',
			resetAt: new Date('2026-11-24T09:10:11Z'),
			passed: false,
		},
	});

	// Expired cache re-runs; errors return {kind: 'error'} and ARE cached for the TTL.
	clock += 40_000;
	result = {kind: 'error'};
	expect(
		await reader('~/bin/agy', {env: {FOO: 'bar'}, unset: ['DROP_ME']}),
	).toStrictEqual({kind: 'error'});
	expect(calls.length).toBe(2);

	clock += 10_000;
	expect(
		await reader('~/bin/agy', {env: {FOO: 'bar'}, unset: ['DROP_ME']}),
	).toStrictEqual({kind: 'error'});
	expect(calls.length).toBe(2);

	// Once negative TTL expires, re-runs and recovers.
	clock += 60_000;
	result = {
		kind: 'ok',
		output:
			'Gemini Models\tFive Hour Limit Remaining\t0%\t2026-11-24T10:00:00Z\n',
	};
	const recovered = await reader('~/bin/agy', {
		env: {FOO: 'bar'},
		unset: ['DROP_ME'],
		model: 'gemini-4',
	});
	expect(calls.length).toBe(3);
	expect(recovered).toStrictEqual({
		kind: 'limited',
		limit: {
			resetText: '2026-11-24T10:00:00Z',
			resetAt: new Date('2026-11-24T10:00:00Z'),
			passed: false,
		},
	});
});
