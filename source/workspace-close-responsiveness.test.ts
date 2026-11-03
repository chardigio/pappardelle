import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'ava';
import {innerKillSession} from './tmux.ts';

const execFileAsync = promisify(execFile);

test('slow session kills and simulator cleanup leave the event loop responsive', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-close-slow-'));
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	for (const command of ['tmux', 'xcrun']) {
		fs.writeFileSync(
			path.join(dir, command),
			`#!/usr/bin/env node
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
	const registryUrl = new URL('space-registry.ts', import.meta.url).href;
	const utilsUrl = new URL('space-utils.ts', import.meta.url).href;
	const simulatorUrl = new URL('qa-simulator.ts', import.meta.url).href;
	const script = `
import {killSpaceSessions, displayMessageInPaneAsync} from ${JSON.stringify(tmuxUrl)};
import {setRegistryPath, addSpace, removeSpace, getRegisteredSpaces} from ${JSON.stringify(registryUrl)};
import {tearDownSpace} from ${JSON.stringify(utilsUrl)};
import {QaSimulatorCleanup} from ${JSON.stringify(simulatorUrl)};
setRegistryPath(process.env.CLOSE_REGISTRY);
await addSpace('A');
await addSpace('B');
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const cleanup = new QaSimulatorCleanup();
let cleanupJob;
let cleaned = false;
const started = performance.now();
const closed = await tearDownSpace('A', {
  killSpaceSessions: key => killSpaceSessions(key, {repoName: 'fixture'}),
  cleanup: key => {
    cleanupJob = cleanup.delete(key).then(result => { cleaned = true; return result; });
    return cleanupJob;
  },
  removeSpace,
  onKillFailure: () => { throw new Error('kill failed'); },
});
const closeMs = performance.now() - started;
const closeTicks = ticks;
const cleanupPendingAtClose = !cleaned;
await displayMessageInPaneAsync('%fixture', 'Session closed');
const cleanupResult = await cleanupJob;
clearInterval(timer);
console.log(JSON.stringify({closed, closeMs, closeTicks, cleanupPendingAtClose, cleanupResult, ticks, registered: getRegisteredSpaces()}));
`;
	const callsFile = path.join(dir, 'calls');
	const {stdout} = await execFileAsync(
		process.execPath,
		['--import', 'tsx', '--input-type=module', '-e', script],
		{
			env: {
				...process.env,
				PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
				CLOSE_CALLS: callsFile,
				CLOSE_REGISTRY: path.join(dir, 'registry.json'),
			},
			timeout: 15_000,
		},
	);
	const result = JSON.parse(stdout) as {
		closed: boolean;
		closeMs: number;
		closeTicks: number;
		cleanupPendingAtClose: boolean;
		cleanupResult: boolean;
		ticks: number;
		registered: string[];
	};
	t.true(result.closed);
	t.true(result.closeTicks >= 5);
	t.true(result.cleanupPendingAtClose);
	t.true(result.cleanupResult);
	t.true(result.ticks > result.closeTicks + 10);
	t.deepEqual(result.registered, ['B']);
	const calls = fs
		.readFileSync(callsFile, 'utf8')
		.trim()
		.split('\n')
		.map(line => JSON.parse(line) as {command: string; args: string[]});
	t.is(
		calls.filter(
			call => call.command === 'tmux' && call.args.includes('kill-session'),
		).length,
		// companion, agent, and the legacy agent name
		3,
	);
	t.false(calls.some(call => call.args.includes('has-session')));
	t.is(
		calls.filter(call => call.command === 'xcrun' && call.args.includes('list'))
			.length,
		1,
	);
	t.deepEqual(
		calls.find(call => call.command === 'xcrun' && call.args.includes('delete'))
			?.args,
		['simctl', 'delete', 'fixture-device'],
	);
	t.log(
		`close dispatched/completed in ${result.closeMs.toFixed(1)} ms; ${result.closeTicks} timer ticks during session close, ${result.ticks} including cleanup`,
	);
});

test('real isolated tmux session close uses exact targets and tolerates already absent sessions', async t => {
	try {
		await execFileAsync('tmux', ['-V']);
	} catch {
		t.pass('tmux unavailable');
		return;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-close-tmux-'));
	const socket = path.join(dir, 'socket');
	const run = async (args: string[]) => {
		const {stdout} = await execFileAsync(
			'tmux',
			['-S', socket, ...args.slice(2)],
			{env: {...process.env, TMUX: ''}, timeout: 5000},
		);
		return stdout;
	};
	t.teardown(async () => {
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
	t.true(await innerKillSession('fixture-A', run));
	t.true(await innerKillSession('fixture-A', run));
	const {stdout} = await execFileAsync('tmux', [
		'-S',
		socket,
		'list-sessions',
		'-F',
		'#{session_name}',
	]);
	t.is(stdout.trim(), 'fixture-AB');
	t.true(await innerKillSession('fixture-AB', run));
	t.true(await innerKillSession('fixture-AB', run));
});
