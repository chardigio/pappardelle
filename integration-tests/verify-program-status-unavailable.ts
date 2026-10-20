import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	attachStatusMonitor,
	shellQuoteStatus,
} from '../source/program-status-monitor.ts';
import {StatusHarness, until} from './program-status-harness.ts';

assert.ok(
	process.argv.includes('--live'),
	'Pass --live to run the installed CLI',
);
const agent = process.argv[process.argv.indexOf('--agent') + 1];
assert.ok(
	agent === 'opencode' || agent === 'agy',
	'Pass --agent opencode or --agent agy',
);
const version = execFileSync(agent, ['--version'], {encoding: 'utf8'}).trim();
const harness = new StatusHarness();
const repo = `${agent}-prototype`;
const key = `STATUS-${agent.toUpperCase()}`;
const session = `${agent}-status-live`;
const reply = `${agent.toUpperCase()}_VERIFIED`;
const task = `Return only the two parts ${agent.toUpperCase()}_ and VERIFIED joined together with no spaces. Do not use tools or inspect any files.`;
let model: unknown;
let apertureBaseUrl: string | undefined;
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
				.map(line => JSON.parse(line) as {type: string; report?: unknown}),
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
		'/bin/bash',
		'--noprofile',
		'--rcfile',
		shellStartup,
		'-i',
	]);
	await attachStatusMonitor(repo, key, session);
	const statuses = await harness.mount(repo, key, session);
	const args =
		agent === 'opencode'
			? [agent, '--standalone', '--prompt', task]
			: [
					agent,
					'--effort',
					'low',
					'--mode',
					'plan',
					'--prompt-interactive',
					task,
				];
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
			return screen;
		},
		screen => screen.includes(reply),
		`${agent} completed its real model turn`,
		120000,
	);
	harness.checks.push({
		label: 'real model turn returned the expected non-echoed reply',
	});
	if (agent === 'opencode') {
		const options = {cwd: harness.root, encoding: 'utf8' as const};
		const ownSession = execFileSync(agent, ['session', 'list'], options)
			.trim()
			.split('\t')[0]!;
		assert.match(ownSession, /^ses_[A-Za-z\d]+$/);
		const exported = JSON.parse(
			execFileSync(agent, ['session', 'export', ownSession], options),
		) as {info: {model: {id: string; providerID: string}}};
		model = exported.info.model;
		const configs = JSON.parse(
			execFileSync(agent, ['debug', 'config'], options),
		) as Array<{
			info?: {providers?: Record<string, {settings?: {baseURL?: string}}>};
		}>;
		apertureBaseUrl = configs
			.map(
				config =>
					config.info?.providers?.[exported.info.model.providerID]?.settings
						?.baseURL,
			)
			.find(Boolean);
		assert.ok(apertureBaseUrl);
		assert.equal(
			new URL(apertureBaseUrl).hostname,
			'ai',
			'Model must use the configured Tailscale Aperture',
		);
		harness.checks.push({
			label: 'selected model provider uses the configured Tailscale Aperture',
		});
	}
	await delay(1000);
	assert.equal(
		reports().length,
		0,
		`${agent} now emits native reports; use a positive verification instead`,
	);
	const info = await statuses.read(key);
	assert.equal(info?.status ?? 'unknown', 'unknown');
	assert.equal(info?.source, undefined);
	await harness.expectUnknown(
		'completed CLI remains honestly unknown without native reports or hooks',
	);
	await harness.tmux(['send-keys', '-t', `=${session}:`, '-l', '/exit']);
	await delay(250);
	await harness.tmux(['send-keys', '-t', `=${session}:`, 'Enter']);
	await until(
		async () => harness.screen(session),
		screen => screen.trimEnd().endsWith('PAPPARDELLE_FIXTURE_PROMPT>'),
		`${agent} returned to its fixture shell`,
		30000,
	);
	assert.equal(reports().length, 0);
	await harness.expectUnknown('no status is invented on CLI exit');
	writeFileSync(
		path.join(harness.root, `${agent}-verification.json`),
		JSON.stringify(
			{
				agent,
				version,
				model,
				apertureBaseUrl,
				checks: harness.checks,
				nativeReports: reports(),
			},
			null,
			2,
		),
	);
	console.log(
		`Passed ${harness.checks.length} checks; no OSC 7501 reports; evidence ${harness.root}/${agent}-verification.json`,
	);
} catch (error) {
	writeFileSync(
		path.join(harness.root, `${agent}-verification.json`),
		JSON.stringify(
			{
				agent,
				version,
				model,
				apertureBaseUrl,
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
