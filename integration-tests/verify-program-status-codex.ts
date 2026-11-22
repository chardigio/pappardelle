import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {shellQuoteStatus} from '../source/program-status-monitor.ts';
import {StatusHarness, until} from './program-status-harness.ts';

assert.ok(
	process.argv.includes('--live'),
	'Pass --live to run interactive Codex',
);
const binary = process.env['PAPPARDELLE_CODEX_BIN'] ?? 'codex';
const version = execFileSync(binary, ['--version'], {encoding: 'utf8'}).trim();
const auth = path.join(
	process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex'),
	'auth.json',
);
assert.ok(existsSync(auth), 'Authenticate Codex before running this fixture');
const harness = new StatusHarness();
const repo = 'codex-prototype';
const key = 'STATUS-CODEX';
const session = 'codex-status-live';
const testHome = path.join(harness.root, 'codex-home');
let statuses: Awaited<ReturnType<StatusHarness['mount']>>;

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
		'env',
		`CODEX_HOME=${testHome}`,
		binary,
		...(resume ? ['resume', '--last'] : []),
		'--no-daemon',
		'--no-alt-screen',
		'--sandbox',
		'read-only',
		'--ask-for-approval',
		'on-request',
		'--config',
		'features.apps=false',
		'--config',
		'features.default_mode_request_user_input=true',
		'--config',
		`projects.${JSON.stringify(harness.root)}.trust_level="trusted"`,
	];
	await harness.type(
		session,
		args.map(value => shellQuoteStatus(value)).join(' '),
	);
	await harness.expect(
		'idle',
		`${resume ? 'resume' : 'fresh launch'} emits native idle`,
		{source: 'osc', app: 'codex'},
		'●',
		60000,
	);
}

async function turn(text: string, label: string) {
	await prompt(text);
	await harness.expect(
		'working',
		`${label}: native working`,
		{source: 'osc', app: 'codex'},
		undefined,
		60000,
	);
	await expectCompletion(`${label}: native completion`);
}

async function expectCompletion(label: string) {
	const info = await until(
		async () => statuses.read(key),
		value => value?.status === 'idle' || value?.status === 'done',
		label,
		120000,
	);
	await harness.expect(
		info!.status,
		label,
		{source: 'osc', app: 'codex'},
		'●',
		120000,
	);
}

try {
	mkdirSync(testHome);
	symlinkSync(auth, path.join(testHome, 'auth.json'));
	writeFileSync(
		path.join(testHome, 'config.toml'),
		'model_reasoning_effort = "low"\n',
	);
	writeFileSync(
		path.join(harness.root, 'AGENTS.md'),
		'This is a disposable protocol fixture. Only perform the explicitly requested action. Do not inspect other directories, use external services, or delegate. Keep replies brief.\n',
	);
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
		'/bin/bash',
		'-l',
	]);
	await harness.programStatus(repo).attach(key, session);
	statuses = await harness.mount(repo, key, session);
	console.log(`Fixture ${harness.root}; ${version}`);
	await launch();
	await turn(
		'Reply with exactly: native Codex status verified. Do not use tools.',
		'simple turn',
	);
	await harness.writeHook(key, 'error');
	await delay(250);
	await expectCompletion(
		'native Codex status overrides conflicting Claude hook',
	);

	const approved = path.join(harness.root, 'approved.txt');
	await prompt(
		`Run exactly this shell command with sandbox_permissions="require_escalated" and ask me for approval: printf approved > ${shellQuoteStatus(approved)}. It is already shellchecked. Do not use apply_patch or any other tools. After approval reply briefly.`,
	);
	await harness.expect(
		'blocked',
		'approval emits native blocked and attention indicator',
		{source: 'osc', app: 'codex'},
		'!',
		120000,
	);
	await until(
		async () => harness.screen(session),
		screen =>
			/Yes, proceed|Would you like to run|approve this command/.test(screen),
		'Codex approval prompt',
		30000,
	);
	await keys('Enter');
	await expectCompletion('approved action reaches completion');
	assert.equal(readFileSync(approved, 'utf8'), 'approved');
	harness.checks.push({
		label: 'approved command produced the expected fixture file',
	});

	await turn(
		'Reply with exactly: another turn verified. Do not use tools.',
		'another turn',
	);
	await prompt('/exit');
	await harness.expect(
		'unknown',
		'Codex exit clears native status',
		{source: 'osc'},
		'?',
		30000,
	);
	await delay(500);
	await launch(true);
	await turn(
		'Reply with exactly: resumed native session. Do not use tools.',
		'resumed turn',
	);
	await prompt('/exit');
	await harness.expect(
		'unknown',
		'resumed Codex exit clears native status',
		{source: 'osc'},
		'?',
		30000,
	);
	writeFileSync(
		path.join(harness.root, 'codex-verification.json'),
		JSON.stringify({version, checks: harness.checks}, null, 2),
	);
	console.log(
		`Passed ${harness.checks.length} checks; evidence ${harness.root}/codex-verification.json`,
	);
} catch (error) {
	writeFileSync(
		path.join(harness.root, 'codex-verification.json'),
		JSON.stringify(
			{
				version,
				checks: harness.checks,
				error: String(error),
			},
			null,
			2,
		),
	);
	throw error;
} finally {
	rmSync(testHome, {recursive: true, force: true});
	await harness.cleanup();
}
