import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {publishSnapshot, snapshotOf} from '../test/helpers/program-status.ts';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {parseStatusPane} from './program-status-monitor.ts';
import {defaultSuperviseDeps, readAgyQuota} from './supervise-runtime.ts';

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

test('readAgyQuota strips PAPPARDELLE_* and TMUX*, expands ~/, forwards env/unset/model, and handles errors', async () => {
	const now = () => new Date('2026-11-24T08:00:00Z');
	const baseEnv: NodeJS.ProcessEnv = {
		HOME: '/home/qa',
		PATH: '/bin',
		PAPPARDELLE_SPACE: 'STA-1',
		PAPPARDELLE_REPO: 'repo',
		TMUX: '/tmp/tmux-1000/default,1,0',
		TMUX_PANE: '%1',
		TMUX_TMPDIR: '/tmp',
		DROP_ME: '1',
	};
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
	const run = async (
		command: string,
		args: readonly string[],
		opts: {env: NodeJS.ProcessEnv},
	) => {
		calls.push({command, args, env: opts.env});
		return result;
	};

	const gemini = await readAgyQuota('~/bin/agy', {
		baseEnv,
		env: {FOO: 'bar'},
		unset: ['DROP_ME'],
		model: 'gemini-4-hydrogen-medium',
		now,
		run,
	});
	expect(gemini).toStrictEqual({kind: 'available'});
	expect(calls[0]).toStrictEqual({
		command: '/home/qa/bin/agy',
		args: ['-p', '/quota'],
		env: {HOME: '/home/qa', PATH: '/bin', FOO: 'bar'},
	});

	const claude = await readAgyQuota('~/bin/agy', {
		baseEnv,
		model: 'claude-sonnet-4-6',
		now,
		run,
	});
	expect(claude).toStrictEqual({
		kind: 'limited',
		limit: {
			resetText: '2026-11-24T09:10:11Z',
			resetAt: new Date('2026-11-24T09:10:11Z'),
			passed: false,
		},
	});

	result = {kind: 'error'};
	expect(await readAgyQuota('~/bin/agy', {baseEnv, now, run})).toStrictEqual({
		kind: 'error',
	});
});
