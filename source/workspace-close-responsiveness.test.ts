import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {tmuxTest} from '../test/helpers/tmux-test.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {innerKillSession} from './tmux.ts';

const execFileAsync = promisify(execFile);

test('slow session kills and simulator cleanup leave the event loop responsive', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-close-slow-'));
	teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	for (const command of ['tmux', 'xcrun']) {
		fs.writeFileSync(
			path.join(dir, command),
			`#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLOSE_CALLS, JSON.stringify({command: ${JSON.stringify(command)}, args}) + '\\n');
setTimeout(() => {
  if (args.includes('list')) console.log(JSON.stringify({devices: {runtime: [{name: 'QA-A', udid: 'fixture-device'}]}}));
}, args.includes('delete') ? 300 : 100);
`,
			{mode: 0o755},
		);
	}
	const tmuxUrl = new URL('tmux.ts', import.meta.url).href;
	const daosUrl = new URL('state-daos.ts', import.meta.url).href;
	const utilsUrl = new URL('space-utils.ts', import.meta.url).href;
	const simulatorUrl = new URL('qa-simulator.ts', import.meta.url).href;
	const script = `
import {killSpaceSessions, displayMessageInPaneAsync, initTmuxState} from ${JSON.stringify(tmuxUrl)};
import {createStateDaos} from ${JSON.stringify(daosUrl)};
import {newSpaceIdentity} from ${JSON.stringify(new URL('space-identity.ts', import.meta.url).href)};
import {tearDownSpace} from ${JSON.stringify(utilsUrl)};
import {QaSimulatorCleanup} from ${JSON.stringify(simulatorUrl)};
const daos = createStateDaos({repo: 'fixture', stateDir: process.env.CLOSE_STATE_DIR});
const {registry} = daos;
initTmuxState(daos);
for (const key of ['A', 'B'])
  await daos.spaceIdentities.record(newSpaceIdentity({repo: 'fixture', key, worktreePath: '/w/' + key, socket: 'pappardelle_inner'}));
await registry.add('A');
await registry.add('B');
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const cleanup = new QaSimulatorCleanup();
let cleanupJob;
let cleaned = false;
const started = performance.now();
const closed = await tearDownSpace('A', {
  markClosing: key => registry.markClosing(key),
  reopen: key => registry.reopen(key),
  killSpaceSessions: key => killSpaceSessions(key),
  cleanup: key => {
    cleanupJob = cleanup.delete(key).then(result => { cleaned = true; return result; });
    return cleanupJob;
  },
  removeSpace: key => registry.remove(key),
  onKillFailure: () => { throw new Error('kill failed'); },
});
const closeMs = performance.now() - started;
const closeTicks = ticks;
const cleanupPendingAtClose = !cleaned;
await displayMessageInPaneAsync('%fixture', 'Session closed');
const cleanupResult = await cleanupJob;
clearInterval(timer);
console.log(JSON.stringify({closed, closeMs, closeTicks, cleanupPendingAtClose, cleanupResult, ticks, registered: registry.openSpaces()}));
`;
	const callsFile = path.join(dir, 'calls');
	const {stdout} = await execFileAsync(
		process.execPath,
		['--input-type=module', '-e', script],
		{
			env: {
				...process.env,
				PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
				CLOSE_CALLS: callsFile,
				CLOSE_STATE_DIR: path.join(dir, 'state'),
			},
			timeout: 15_000,
		},
	);
	const result = JSON.parse(stdout) as {
		closed: {outcome: string};
		closeMs: number;
		closeTicks: number;
		cleanupPendingAtClose: boolean;
		cleanupResult: boolean;
		ticks: number;
		registered: string[];
	};
	expect(result.closed.outcome).toBe('closed');
	expect(result.closeTicks >= 5).toBe(true);
	expect(result.cleanupPendingAtClose).toBe(true);
	expect(result.cleanupResult).toBe(true);
	expect(result.ticks > result.closeTicks + 10).toBe(true);
	expect(result.registered).toStrictEqual(['B']);
	const calls = fs
		.readFileSync(callsFile, 'utf8')
		.trim()
		.split('\n')
		.map(line => JSON.parse(line) as {command: string; args: string[]});
	expect(
		calls.filter(
			call => call.command === 'tmux' && call.args.includes('kill-session'),
		).length,
	).toBe(3);
	expect(calls.some(call => call.args.includes('has-session'))).toBe(false);
	expect(
		calls.filter(call => call.command === 'xcrun' && call.args.includes('list'))
			.length,
	).toBe(1);
	expect(
		calls.find(call => call.command === 'xcrun' && call.args.includes('delete'))
			?.args,
	).toStrictEqual(['simctl', 'delete', 'fixture-device']);
	console.log(
		`close dispatched/completed in ${result.closeMs.toFixed(1)} ms; ${result.closeTicks} timer ticks during session close, ${result.ticks} including cleanup`,
	);
});

tmuxTest(
	'real isolated tmux session close uses exact targets and tolerates already absent sessions',
	async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'pappardelle-close-tmux-'),
		);
		const socket = path.join(dir, 'socket');
		const run = async (args: string[]) => {
			const {stdout} = await execFileAsync(
				'tmux',
				['-S', socket, ...args.slice(2)],
				{env: {...process.env, TMUX: ''}, timeout: 5000},
			);
			return stdout;
		};
		teardown(async () => {
			try {
				await execFileAsync('tmux', ['-S', socket, 'kill-server']);
			} catch {}
			fs.rmSync(dir, {recursive: true, force: true});
		});
		await execFileAsync(
			'tmux',
			[
				'-S',
				socket,
				'-f',
				'/dev/null',
				'new-session',
				'-d',
				'-s',
				'fixture-A',
				'sleep 60',
			],
			{env: {...process.env, TMUX: ''}},
		);
		await execFileAsync('tmux', [
			'-S',
			socket,
			'new-session',
			'-d',
			'-s',
			'fixture-AB',
			'sleep 60',
		]);
		expect(await innerKillSession('fixture-A', run)).toBe(true);
		expect(await innerKillSession('fixture-A', run)).toBe(true);
		const {stdout} = await execFileAsync('tmux', [
			'-S',
			socket,
			'list-sessions',
			'-F',
			'#{session_name}',
		]);
		expect(stdout.trim()).toBe('fixture-AB');
		expect(await innerKillSession('fixture-AB', run)).toBe(true);
		expect(await innerKillSession('fixture-AB', run)).toBe(true);
	},
);
