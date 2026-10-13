import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	attachStatusMonitor,
	shellQuoteStatus,
	statusShellCommand,
} from '../source/program-status-monitor.ts';
import {StatusHarness} from './program-status-harness.ts';

assert.ok(process.argv.includes('--live'), 'Pass --live to run interactive Pi');
const binary = process.env['PAPPARDELLE_PI_BIN'] ?? 'pi';
const model = process.env['PAPPARDELLE_PI_MODEL'] ?? 'openai/gpt-6.1-sol';
const version = execFileSync(binary, ['--version'], {encoding: 'utf8'}).trim();
const harness = new StatusHarness();
const repo = 'pi-prototype';
const key = 'STATUS-PI';
const session = 'pi-status-live';
const conversation = randomUUID();
const extension = path.join(harness.root, 'status-dialogs.mjs');
writeFileSync(
	extension,
	`export default function(pi) {
  pi.registerCommand("fixture-question", {description: "Protocol fixture question", handler: async (_args, ctx) => {
    await ctx.ui.select("Fixture question", ["Alpha", "Beta"]);
  }});
  pi.registerCommand("fixture-permission", {description: "Protocol fixture confirmation", handler: async (_args, ctx) => {
    await ctx.ui.confirm("Fixture approval", "Allow this harmless fixture confirmation?");
  }});
}
`,
);

async function keys(...values: string[]) {
	await harness.tmux(['send-keys', '-t', `=${session}:`, ...values]);
}

async function prompt(text: string) {
	await keys('C-u');
	await harness.tmux(['send-keys', '-t', `=${session}:`, '-l', text]);
	await delay(250);
	await keys('Enter');
}

async function launch(label: string) {
	const args = [
		'env',
		'-u',
		'PI_PROGRAM_STATUS',
		binary,
		'--model',
		model,
		'--thinking',
		'low',
		'--no-tools',
		'--no-extensions',
		'--no-mcp',
		'--no-skills',
		'--no-prompt-templates',
		'--no-context-files',
		'--session-dir',
		path.join(harness.root, 'sessions'),
		'--session-id',
		conversation,
		'--name',
		key,
		'--extension',
		extension,
	];
	await harness.type(
		session,
		args.map(value => shellQuoteStatus(value)).join(' '),
	);
	await harness.expect(
		'idle',
		`${label}: detected native idle`,
		{source: 'osc', app: 'pi'},
		'●',
		60000,
	);
}

async function turn(label: string) {
	await prompt(`Reply with exactly: ${label}. Do not use tools.`);
	await harness.expect(
		'working',
		`${label}: native working`,
		{source: 'osc', app: 'pi'},
		undefined,
		60000,
	);
	await harness.expect(
		'done',
		`${label}: native completion`,
		{source: 'osc', app: 'pi'},
		'●',
		120000,
	);
}

try {
	await harness.tmux([
		'new-session',
		'-d',
		'-s',
		session,
		'-x',
		'130',
		'-y',
		'45',
		'-c',
		harness.root,
		'-e',
		`HISTFILE=${path.join(harness.root, 'shell-history')}`,
		statusShellCommand(),
	]);
	await attachStatusMonitor(repo, key, session);
	await harness.mount(repo, key, session);
	console.log(`Fixture ${harness.root}; Pi ${version}; model=${model}`);
	await launch('fresh launch');
	await prompt('/fixture-question');
	await harness.expect(
		'blocked',
		'native question kind and decoded message',
		{source: 'osc', app: 'pi', kind: 'question', message: 'Fixture question'},
		'?',
	);
	await keys('Enter');
	await harness.expect(
		'idle',
		'question answer restores idle',
		{source: 'osc', app: 'pi'},
		'●',
	);
	await prompt('/fixture-permission');
	await harness.expect(
		'blocked',
		'native permission kind and decoded message',
		{source: 'osc', app: 'pi', kind: 'permission', message: 'Fixture approval'},
		'!',
	);
	await keys('Enter');
	await harness.expect(
		'idle',
		'confirmation restores idle',
		{source: 'osc', app: 'pi'},
		'●',
	);
	await prompt('/fixture-permission');
	await harness.expect(
		'blocked',
		'second confirmation receives attention',
		{source: 'osc', kind: 'permission'},
		'!',
	);
	await keys('Escape');
	await harness.expect(
		'idle',
		'denied confirmation restores idle',
		{source: 'osc', app: 'pi'},
		'●',
	);
	await turn('Pi status verified');
	harness.writeHook(key, 'error');
	await delay(250);
	await harness.expect(
		'done',
		'native completion overrides conflicting Claude hook',
		{source: 'osc', app: 'pi'},
		'●',
	);
	await turn('Another turn verified');
	await prompt('Explain this fixture in 200 words. Do not use tools.');
	await harness.expect(
		'working',
		'working before interruption',
		{source: 'osc', app: 'pi'},
		undefined,
		60000,
	);
	await keys('Escape');
	await harness.expect(
		'idle',
		'interruption restores idle',
		{source: 'osc', app: 'pi'},
		'●',
		30000,
	);
	await turn('Turn after interruption verified');
	await prompt('/quit');
	await harness.expect(
		'unknown',
		'Pi quit clears native status',
		{source: 'osc'},
		'?',
		30000,
	);
	await delay(500);
	await launch('resume');
	await turn('Resumed Pi session verified');
	await prompt('/quit');
	await harness.expect(
		'unknown',
		'resumed Pi quit clears native status',
		{source: 'osc'},
		'?',
		30000,
	);
	writeFileSync(
		path.join(harness.root, 'pi-verification.json'),
		JSON.stringify({version, model, checks: harness.checks}, null, 2),
	);
	console.log(
		`Passed ${harness.checks.length} checks; evidence ${harness.root}/pi-verification.json`,
	);
} catch (error) {
	writeFileSync(
		path.join(harness.root, 'pi-verification.json'),
		JSON.stringify(
			{version, model, checks: harness.checks, error: String(error)},
			null,
			2,
		),
	);
	throw error;
} finally {
	await harness.cleanup();
}
