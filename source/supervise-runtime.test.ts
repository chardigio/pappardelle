import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {testState} from '../test/helpers/state.ts';
import {getRepoName} from './config.ts';
import {programStatusDir} from './program-status-monitor.ts';
import {defaultSuperviseDeps} from './supervise-runtime.ts';

test.serial(
	'a supervised wait ends early when a hook status or a native status changes',
	async t => {
		const state = testState(t);
		const previous = process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'];
		process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'] = path.join(
			state.stateDir,
			'program-status',
		);
		t.teardown(() => {
			if (previous === undefined)
				Reflect.deleteProperty(process.env, 'PAPPARDELLE_PROGRAM_STATUS_DIR');
			else process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'] = previous;
		});
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
				state.daos.claudeStatus.write({
					sessionId: 'session',
					workspaceName: 'repo-STA-1',
					status: 'waiting_for_approval',
					lastUpdate: Date.now(),
				}),
			)) < 2000,
		);
		t.true(
			(await waited(3000, () => {
				fs.writeFileSync(
					path.join(programStatusDir(getRepoName()), 'STA-1.json'),
					'{}',
				);
			})) < 2000,
		);
		t.true((await waited(200)) >= 190);
	},
);
