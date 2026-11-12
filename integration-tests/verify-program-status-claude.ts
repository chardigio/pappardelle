import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {shellQuoteStatus} from '../source/program-status-monitor.ts';
import {StatusHarness, projectRoot, until} from './program-status-harness.ts';

assert.ok(
	process.argv.includes('--live'),
	'Pass --live to run authenticated, interactive Claude sessions',
);
const version = execFileSync('claude', ['--version'], {
	encoding: 'utf8',
}).trim();
const harness = new StatusHarness();
const repo = 'claude-prototype';
const key = 'STATUS-LIVE';
const session = 'claude-status-live';
const conversation = randomUUID();
const hookScript = path.join(
	projectRoot,
	'plugins/pappardelle/hooks/update-status.py',
);
const settings = path.join(harness.root, 'claude-settings.json');
const template = JSON.parse(
	readFileSync(
		path.join(projectRoot, 'plugins/pappardelle/hooks/hooks.json'),
		'utf8',
	),
) as {
	hooks: Record<
		string,
		Array<{matcher?: string; hooks: Array<{type: string; command: string}>}>
	>;
};
const hooks = Object.fromEntries(
	Object.entries(template.hooks).map(([event, entries]) => [
		event,
		entries.flatMap(entry => {
			const statusHooks = entry.hooks.filter(hook =>
				hook.command.includes('update-status.py'),
			);
			return statusHooks.length
				? [
						{
							...entry,
							hooks: statusHooks.map(hook => ({
								...hook,
								command: ['python3', hookScript]
									.map(value => shellQuoteStatus(value))
									.join(' '),
							})),
						},
					]
				: [];
		}),
	]),
);
writeFileSync(settings, JSON.stringify({hooks}));

async function keys(...values: string[]) {
	await harness.tmux(['send-keys', '-t', `=${session}:`, ...values]);
}

async function prompt(text: string) {
	await keys('C-u');
	await harness.tmux(['send-keys', '-t', `=${session}:`, '-l', text]);
	await delay(250);
	await keys('Enter');
}

async function launch(resume = false) {
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
		'--setting-sources',
		'project',
		'--settings',
		settings,
		'--strict-mcp-config',
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
		`${resume ? 'resume' : 'fresh launch'} hook reports idle`,
		{source: 'hook', app: 'claude-code'},
		'●',
		60000,
	);
}

async function turn(text: string, label: string) {
	await prompt(text);
	await harness.expect(
		'working',
		`${label}: hook working`,
		{source: 'hook'},
		undefined,
		60000,
	);
	await harness.expect(
		'idle',
		`${label}: Stop hook reaches the rail row`,
		{source: 'hook'},
		'●',
		60000,
	);
}

async function leave() {
	await prompt('/exit');
	await until(
		() =>
			JSON.parse(
				readFileSync(path.join(harness.root, 'hooks', `${key}.json`), 'utf8'),
			) as {event?: string},
		state => state.event === 'SessionEnd',
		'SessionEnd hook records shell return',
	);
	await harness.expect(
		'idle',
		'Claude exit preserves legacy ended status',
		{source: 'hook'},
		'●',
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
		'/bin/bash',
		'-l',
	]);
	await harness.programStatus(repo).attach(key, session);
	await harness.mount(repo, key, session);
	await launch();
	await turn(
		'Reply with exactly: Hook status ready. Do not use tools.',
		'simple turn',
	);
	await prompt(
		'Use AskUserQuestion to ask me which fixture label to use. Give exactly two options: Red and Blue. Do not choose for me.',
	);
	await harness.expect(
		'blocked',
		'AskUserQuestion renders blue question',
		{source: 'hook', kind: 'question'},
		'?',
		60000,
	);
	await keys('Enter');
	await harness.expect(
		'idle',
		'answering question completes turn',
		{source: 'hook'},
		'●',
		60000,
	);
	await prompt(
		'Use Bash to run exactly: printf approved > approved-marker.txt. Wait for permission if requested. Do not use other tools.',
	);
	await harness.expect(
		'blocked',
		'Bash approval renders permission indicator',
		{source: 'hook', kind: 'permission'},
		'!',
		60000,
	);
	await keys('Enter');
	await harness.expect(
		'idle',
		'approval completes harmless fixture action',
		{source: 'hook'},
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
		{source: 'hook', kind: 'permission'},
		'!',
		60000,
	);
	await keys('Escape');
	await until(
		async () => harness.screen(session),
		screen => screen.includes('Interrupted'),
		'Escape cancels the pending action',
	);
	assert.equal(existsSync(path.join(harness.root, 'denied-marker.txt')), false);
	await turn(
		'Reply with exactly: permission cancellation recovered. Do not use tools.',
		'turn after permission cancellation',
	);
	const interruptedCount = (screen: string) =>
		(screen.match(/Interrupted/g) ?? []).length;
	const previousInterruptions = interruptedCount(await harness.screen(session));
	await prompt(
		'Use Bash to run exactly: printf running > interruption-marker.txt; sleep 10. Do not use other tools.',
	);
	await harness.expect(
		'blocked',
		'interruption fixture requests permission',
		{source: 'hook', kind: 'permission'},
		'!',
		60000,
	);
	await keys('Enter');
	await until(
		() => existsSync(path.join(harness.root, 'interruption-marker.txt')),
		Boolean,
		'tool execution starts before interruption',
	);
	await keys('C-c');
	await until(
		async () => harness.screen(session),
		screen => interruptedCount(screen) > previousInterruptions,
		'keyboard interruption reaches Claude',
	);
	await turn(
		'Reply with exactly: another turn after interruption. Do not use tools.',
		'another turn',
	);
	await leave();
	await launch(true);
	await turn(
		'Reply with exactly: resumed hook session. Do not use tools.',
		'hook resume',
	);
	await leave();
	const traces = readdirSync(path.join(harness.root, 'trace')).filter(file =>
		file.endsWith('.jsonl'),
	);
	const reports = traces.flatMap(file =>
		readFileSync(path.join(harness.root, 'trace', file), 'utf8')
			.trim()
			.split('\n')
			.map(line => JSON.parse(line) as {type: string}),
	);
	assert.ok(
		reports.every(event => event.type !== 'report'),
		'Claude must use hooks without native status reports',
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
			{
				version,
				checks: harness.checks,
				failure: String(error),
				screen: await harness.screen(session),
			},
			null,
			2,
		),
	);
	console.error(`Live verification failed; evidence ${harness.root}`);
	throw error;
} finally {
	await harness.cleanup(repo, key);
}
