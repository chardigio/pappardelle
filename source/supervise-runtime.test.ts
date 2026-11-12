import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {publishSnapshot, snapshotOf} from '../test/helpers/program-status.ts';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {parseStatusPane} from './program-status-monitor.ts';
import {defaultSuperviseDeps} from './supervise-runtime.ts';

test.serial(
	'a supervised wait ends early when a hook status or a native status changes',
	async t => {
		const state = testState(t);
		const deps = defaultSuperviseDeps(raw => raw, state.daos);
		const waited = async (ms: number, change?: () => Promise<void> | void) => {
			const started = performance.now();
			const waiting = deps.waitForStatusChange(ms);
			await delay(50);
			await change?.();
			await waiting;
			return performance.now() - started;
		};

		t.true(
			(await waited(3000, async () =>
				writeClaudeStatus(state, {
					sessionId: 'session',
					workspaceName: 'repo-STA-1',
					status: 'waiting_for_approval',
					lastUpdate: Date.now(),
				}),
			)) < 2000,
		);
		t.true(
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
		);
		t.true((await waited(200)) >= 190);
	},
);
