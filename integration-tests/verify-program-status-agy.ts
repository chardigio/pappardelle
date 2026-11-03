import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	attachStatusMonitor,
	shellQuoteStatus,
} from '../source/program-status-monitor.ts';
import {buildAgentSessionEnvArgs} from '../source/spawn-env.ts';
import {StatusHarness, until} from './program-status-harness.ts';

assert.ok(
	process.argv.includes('--live'),
	'Pass --live to run the installed CLI',
);
const agent = 'agy';
const version = execFileSync(agent, ['--version'], {encoding: 'utf8'}).trim();
const harness = new StatusHarness();
const repo = `${agent}-prototype`;
const key = `STATUS-${agent.toUpperCase()}`;
const session = `${agent}-status-live`;
const reply = `${agent.toUpperCase()}_VERIFIED`;
const task = `Return only the two parts ${agent.toUpperCase()}_ and VERIFIED joined together with no spaces. Do not use tools or inspect any files.`;
const shellStartup = path.join(harness.root, 'shell-startup');
writeFileSync(shellStartup, "PS1='PAPPARDELLE_FIXTURE_PROMPT> '\n");

function reports() {
	const dir = path.join(harness.root, 'trace');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(file => file.endsWith('.jsonl'))
		.flatMap(file =>
			readFileSync(path.join(dir, file), 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map(
					line =>
						JSON.parse(line) as {
							type: string;
							report?: {state: string; id?: string; app?: string};
						},
				),
		)
		.filter(event => event.type === 'report');
}

try {
	await harness.tmux([
		'new-session',
		'-d',
		'-s',
		session,
		'-x',
		'140',
		'-y',
		'45',
		'-c',
		harness.root,
		'-e',
		`HISTFILE=${path.join(harness.root, 'shell-history')}`,
		...buildAgentSessionEnvArgs(
			{name: 'agy', isClaude: false},
			path.join(harness.root, 'agent-sessions.json'),
		),
		'/bin/bash',
		'--noprofile',
		'--rcfile',
		shellStartup,
		'-i',
	]);
	await attachStatusMonitor(repo, key, session);
	const statuses = await harness.mount(repo, key, session);
	const args = [agent, '--effort', 'low', '--mode', 'plan'];
	console.log(`Fixture ${harness.root}; ${agent} ${version}`);
	await harness.type(
		session,
		args.map(value => shellQuoteStatus(value)).join(' '),
	);
	await until(
		async () => {
			const screen = await harness.screen(session);
			if (
				/trust this (?:folder|directory)|Do you trust|Trust this project/i.test(
					screen,
				)
			)
				await harness.tmux(['send-keys', '-t', `=${session}:`, 'Enter']);
			return statuses.read(key);
		},
		info => info?.status === 'idle',
		`${agent} native startup idle`,
		60000,
	);
	await harness.expect(
		'idle',
		'native startup idle',
		{source: 'osc', app: 'antigravity'},
		'●',
	);
	await delay(250);
	await harness.type(session, task);
	await harness.expect(
		'working',
		'real turn reports native working',
		{source: 'osc', app: 'antigravity'},
		undefined,
		60000,
	);
	await until(
		async () => {
			const screen = await harness.screen(session);
			if (
				/trust this (?:folder|directory)|Do you trust|Trust this project/i.test(
					screen,
				)
			)
				await harness.tmux(['send-keys', '-t', `=${session}:`, 'Enter']);
			return screen;
		},
		screen => screen.includes(reply),
		`${agent} completed its real model turn`,
		120000,
	);
	harness.checks.push({
		label: 'real model turn returned the expected non-echoed reply',
	});
	await harness.expect(
		'done',
		'real turn reports completion',
		{source: 'osc', app: 'antigravity'},
		'●',
		120000,
	);
	harness.writeHook(key, 'error');
	await delay(250);
	await harness.expect(
		'done',
		'native completion overrides conflicting hook',
		{source: 'osc', app: 'antigravity'},
		'●',
	);
	const native = reports();
	assert.ok(native.some(event => event.report?.state === 'working'));
	assert.ok(native.some(event => event.report?.state === 'done'));
	await harness.tmux(['send-keys', '-t', `=${session}:`, '-l', '/exit']);
	await delay(250);
	await harness.tmux(['send-keys', '-t', `=${session}:`, 'Enter']);
	await until(
		async () => harness.screen(session),
		screen => screen.trimEnd().endsWith('PAPPARDELLE_FIXTURE_PROMPT>'),
		`${agent} returned to its fixture shell`,
		30000,
	);
	await harness.expect(
		'idle',
		'CLI exit leaves idle status and responsive shell',
		{source: 'osc', app: 'antigravity'},
		'●',
	);
	writeFileSync(
		path.join(harness.root, `${agent}-verification.json`),
		JSON.stringify(
			{
				agent,
				version,
				checks: harness.checks,
				nativeReports: reports(),
			},
			null,
			2,
		),
	);
	console.log(
		`Passed ${harness.checks.length} checks; native OSC 7501; evidence ${harness.root}/${agent}-verification.json`,
	);
} catch (error) {
	writeFileSync(
		path.join(harness.root, `${agent}-verification.json`),
		JSON.stringify(
			{
				agent,
				version,
				checks: harness.checks,
				nativeReports: reports(),
				error: String(error),
			},
			null,
			2,
		),
	);
	throw error;
} finally {
	await harness.cleanup();
}
