import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	attachStatusMonitor,
	shellQuoteStatus,
	statusShellCommand,
} from '../source/program-status-monitor.ts';
import {StatusHarness, projectRoot, until} from './program-status-harness.ts';

assert.ok(
	process.argv.includes('--live'),
	'Pass --live to run authenticated, interactive Claude sessions',
);
const version = execFileSync('claude', ['--version'], {
	encoding: 'utf8',
}).trim();
const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
assert.ok(
	match &&
		(Number(match[1]) > 2 ||
			(Number(match[1]) === 2 &&
				(Number(match[2]) > 1 ||
					(Number(match[2]) === 1 && Number(match[3]) >= 295)))),
	`Claude 2.1.295 or newer required: ${version}`,
);
const harness = new StatusHarness();
const repo = 'claude-prototype';
const key = 'STATUS-LIVE';
const session = 'claude-status-live';
const conversation = randomUUID();
const hookScript = path.join(projectRoot, 'hooks/update-status.py');
const settings = path.join(harness.root, 'claude-settings.json');
const hookCommand = (state: string, tool = '') =>
	['python3', hookScript, state, ...(tool ? ['--tool', tool] : [])]
		.map(value => shellQuoteStatus(value))
		.join(' ');
writeFileSync(
	settings,
	JSON.stringify({
		hooks: {
			UserPromptSubmit: [
				{hooks: [{type: 'command', command: hookCommand('processing')}]},
			],
			PreToolUse: [
				{
					matcher: 'Bash',
					hooks: [
						{type: 'command', command: hookCommand('running_tool', 'Bash')},
					],
				},
			],
			PermissionRequest: [
				{
					matcher: 'Bash',
					hooks: [
						{
							type: 'command',
							command: hookCommand('waiting_for_approval', 'Bash'),
						},
					],
				},
			],
			Stop: [
				{hooks: [{type: 'command', command: hookCommand('waiting_for_input')}]},
			],
			SessionEnd: [{hooks: [{type: 'command', command: hookCommand('ended')}]}],
		},
	}),
);

async function keys(...values: string[]) {
	await harness.tmux(['send-keys', '-t', `=${session}:`, ...values]);
}

async function prompt(text: string) {
	await keys('C-u');
	await harness.type(session, text);
}

async function launch(resume = false, hooks = false) {
	const args = [
		'claude',
		'--permission-mode',
		'manual',
		'--effort',
		'low',
		'--prompt-suggestions',
		'false',
		'--name',
		key,
		...(resume ? ['--resume', conversation] : ['--session-id', conversation]),
		...(hooks
			? [
					'--setting-sources',
					'project',
					'--settings',
					settings,
					'--strict-mcp-config',
				]
			: ['--safe-mode']),
	];
	await harness.type(
		session,
		args.map(value => shellQuoteStatus(value)).join(' '),
	);
	// Startup prompts are inspected before choosing their displayed default.
	await until(
		async () => {
			const screen = await harness.screen(session);
			if (
				/trust this folder|Yes, I trust this folder|Enter to confirm|Press Enter to continue/.test(
					screen,
				)
			)
				await keys('Enter');
			return screen;
		},
		screen => screen.includes('manual mode on'),
		'interactive Claude startup',
		60000,
	);
	await harness.expect(
		'idle',
		`${hooks ? 'hooks enabled' : 'native only'} ${resume ? 'resume' : 'fresh launch'} emits idle`,
		{source: 'osc', app: 'claude-code'},
		'●',
		60000,
	);
}

async function turn(text: string, label: string) {
	await prompt(text);
	await harness.expect(
		'working',
		`${label}: native working`,
		{source: 'osc'},
		undefined,
		60000,
	);
	await harness.expect(
		'done',
		`${label}: native completion reaches Ink`,
		{source: 'osc'},
		'●',
		60000,
	);
}

async function leave() {
	await prompt('/exit');
	await harness.expect(
		'unknown',
		'Claude exit clears its record',
		{source: 'osc'},
		'?',
		30000,
	);
	await delay(500);
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
		`PAPPARDELLE_SPACE=${key}`,
		'-e',
		`PAPPARDELLE_STATUS_DIR=${path.join(harness.root, 'hooks')}`,
		statusShellCommand(),
	]);
	await attachStatusMonitor(repo, key, session);
	const statuses = await harness.mount(repo, key, session);
	await launch();
	await turn(
		'Reply with exactly: OSC prototype ready. Do not use tools.',
		'simple turn',
	);
	await prompt(
		'Use AskUserQuestion to ask me which fixture label to use. Give exactly two options: Red and Blue. Do not choose for me.',
	);
	await harness.expect(
		'blocked',
		'AskUserQuestion renders blue question',
		{source: 'osc', kind: 'question'},
		'?',
		60000,
	);
	await keys('Enter');
	await harness.expect(
		'done',
		'answering question completes turn',
		{source: 'osc'},
		'●',
		60000,
	);
	await prompt(
		'Use Bash to run exactly: printf approved > approved-marker.txt. Wait for permission if requested. Do not use other tools.',
	);
	await harness.expect(
		'blocked',
		'Bash approval renders permission indicator',
		{source: 'osc', kind: 'permission'},
		'!',
		60000,
	);
	await keys('Enter');
	await harness.expect(
		'done',
		'approval completes harmless fixture action',
		{source: 'osc'},
		'●',
		60000,
	);
	assert.equal(
		readFileSync(path.join(harness.root, 'approved-marker.txt'), 'utf8'),
		'approved',
	);
	await prompt(
		'Use Bash to run exactly: printf denied > denied-marker.txt. If denied, stop without retrying or using another tool.',
	);
	await harness.expect(
		'blocked',
		'second action requests permission',
		{source: 'osc', kind: 'permission'},
		'!',
		60000,
	);
	await keys('Escape');
	await harness.expect(
		'idle',
		'denying permission returns native idle',
		{source: 'osc'},
		'●',
		60000,
	);
	assert.equal(existsSync(path.join(harness.root, 'denied-marker.txt')), false);
	await prompt(
		'Write a detailed 1000-word explanation of how to organize a temporary test directory. Do not use tools.',
	);
	await harness.expect(
		'working',
		'turn starts before keyboard interruption',
		{source: 'osc'},
		undefined,
		60000,
	);
	await keys('C-c');
	await until(
		async () => statuses.read(key),
		info =>
			info?.source === 'osc' &&
			(info.status === 'idle' || info.status === 'done'),
		'native interruption settles',
		60000,
	);
	const interrupted = await statuses.read(key);
	await harness.expect(
		interrupted!.status,
		'Ctrl-C preserves keyboard input and settles indicator',
		{source: 'osc'},
		'●',
	);
	await turn(
		'Reply with exactly: another turn after interruption. Do not use tools.',
		'another turn',
	);
	await leave();
	await launch(true);
	await turn(
		'Reply with exactly: resumed native session. Do not use tools.',
		'native resume',
	);
	await leave();
	await launch(true, true);
	await turn(
		'Reply with exactly: native status plus hooks. Do not use tools.',
		'hooks enabled resume',
	);
	await until(
		() => existsSync(path.join(harness.root, 'hooks', `${key}.json`)),
		Boolean,
		'real Pappardelle hook wrote fallback',
	);
	harness.writeHook(key, 'error');
	await delay(150);
	await harness.expect(
		'done',
		'conflicting hook remains subordinate to native OSC',
		{source: 'osc'},
		'●',
	);
	await prompt(
		'Use Bash to run exactly: printf hooked > hooked-marker.txt. Wait for permission if requested. Do not use other tools.',
	);
	await harness.expect(
		'blocked',
		'native permission with hooks enabled',
		{source: 'osc', kind: 'permission'},
		'!',
		60000,
	);
	await keys('Enter');
	await harness.expect(
		'done',
		'approval with hooks completes fixture action',
		{source: 'osc'},
		'●',
		60000,
	);
	await prompt('Use Bash to run exactly: sleep 4. Do not use other tools.');
	await harness.expect(
		'working',
		'matching hook tool enriches native work',
		{source: 'osc', tool: 'Bash'},
		undefined,
		60000,
	);
	await harness.expect(
		'done',
		'hook detail clears on native completion',
		{source: 'osc'},
		'●',
		60000,
	);
	const completed = await statuses.read(key);
	assert.equal(completed?.tool, undefined);
	await leave();
	const traces = readdirSync(path.join(harness.root, 'trace')).filter(file =>
		file.endsWith('.jsonl'),
	);
	const reports = traces.flatMap(file =>
		readFileSync(path.join(harness.root, 'trace', file), 'utf8')
			.trim()
			.split('\n')
			.map(line => JSON.parse(line) as unknown),
	);
	writeFileSync(
		path.join(harness.root, 'verification.json'),
		JSON.stringify({version, checks: harness.checks, reports}, null, 2),
	);
	console.log(
		`Passed ${harness.checks.length} interactive checks: ${harness.root}/verification.json (--keep preserves evidence)`,
	);
} catch (error) {
	writeFileSync(
		path.join(harness.root, 'verification.json'),
		JSON.stringify(
			{version, checks: harness.checks, failure: String(error)},
			null,
			2,
		),
	);
	console.error(`Live verification failed; evidence ${harness.root}`);
	throw error;
} finally {
	await harness.cleanup(repo, key);
}
