import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {shellQuoteStatus} from '../source/program-status-monitor.ts';
import type {ProgramStatusSnapshot} from '../source/program-status-monitor.ts';
import {createStateDaos} from '../source/state-daos.ts';
import {subscribeRaw} from '../test/helpers/status-daemon.ts';
import {untilSeen} from './program-status-harness.ts';

assert.ok(
	process.argv.includes('--live'),
	'Pass --live to run installed Codex',
);
const project = fileURLToPath(new URL('..', import.meta.url));
const version = execFileSync('codex', ['--version'], {encoding: 'utf8'}).trim();
const auth = path.join(
	process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex'),
	'auth.json',
);
assert.ok(existsSync(auth), 'Authenticate Codex before running this fixture');
const root = realpathSync(mkdtempSync('/tmp/pappa-codex-rail-'));
const repo = path.join(root, 'workspace');
const home = path.join(root, 'home');
const codexHome = path.join(root, 'codex-home');
const outer = 'codex-rail-outer';
const inner = 'pappardelle_codex_rail';
const branch = 'sd-codex-rail';
const stateDir = path.join(home, '.pappardelle');
const statusSocket = path.join(root, 'status-1.sock');
const frames: Array<{
	scenario: string;
	frame: string;
	snapshot: ProgramStatusSnapshot;
}> = [];
const env = {
	...process.env,
	HOME: home,
	CODEX_HOME: codexHome,
	TMUX_TMPDIR: path.join(root, 'tmux'),
	SHELL: '/bin/bash',
	PAPPARDELLE_PROGRAM_STATUS_DIR: path.join(root, 'status'),
	PAPPARDELLE_PROGRAM_STATUS_TRACE_DIR: path.join(root, 'trace'),
	PAPPARDELLE_STATE_DB: path.join(stateDir, 'state.db'),
	PAPPARDELLE_STATUS_SOCKET: statusSocket,
	PAPPARDELLE_TMUX_SOCKET: inner,
};
Reflect.deleteProperty(env, 'TMUX');
Reflect.deleteProperty(env, 'TMUX_PANE');

function tmux(socket: string, ...args: string[]) {
	return execFileSync('tmux', ['-L', socket, ...args], {
		env,
		encoding: 'utf8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 10000,
	});
}

/** Main's snapshot as the TUI's status daemon holds it. */
async function snapshot(): Promise<ProgramStatusSnapshot | undefined> {
	const closers: Array<() => void> = [];
	try {
		const subscription = await subscribeRaw(
			statusSocket,
			path.basename(repo),
			close => closers.push(close),
		);
		return subscription.messages
			.flatMap(message => (message.type === 'state' ? message.snapshots : []))
			.findLast(value => value.key === 'main');
	} catch {
		// The TUI starts the daemon after its first frame.
		return undefined;
	} finally {
		for (const close of closers) close();
	}
}

function rail() {
	return tmux(outer, 'capture-pane', '-p', '-t', '=tui:0.0');
}

async function expect(
	status: string | readonly string[],
	icon: RegExp,
	scenario: string,
	timeout = 120000,
) {
	const accepted = typeof status === 'string' ? [status] : status;
	const result = await untilSeen(
		async () => ({frame: rail(), snapshot: await snapshot()}),
		value =>
			value.snapshot?.authoritative === true &&
			accepted.includes(value.snapshot.info.status) &&
			(value.snapshot.info.status === 'unknown' ||
				value.snapshot.info.app === 'codex') &&
			value.frame
				.split('\n')
				.some(line => line.includes(' main') && icon.test(line)),
		scenario,
		timeout,
	);
	frames.push({scenario, frame: result.frame, snapshot: result.snapshot!});
	console.log(`PASS TUI rail: ${scenario}`);
}

let agent: string | undefined;
async function prompt(text: string) {
	assert.ok(agent);
	const clients = tmux(inner, 'list-clients', '-F', '#{session_name}')
		.trim()
		.split('\n');
	assert.ok(clients.includes(agent), 'agent viewer uses the selected socket');
	assert.ok(
		clients.includes(agent.replace(/^agent-/, 'companion-')),
		'companion viewer uses the selected socket',
	);
	tmux(inner, 'send-keys', '-t', `=${agent}:`, 'C-u');
	tmux(inner, 'send-keys', '-t', `=${agent}:`, '-l', text);
	await delay(250);
	tmux(inner, 'send-keys', '-t', `=${agent}:`, 'Enter');
}

try {
	for (const dir of [repo, home, codexHome, env.TMUX_TMPDIR])
		mkdirSync(dir, {mode: 0o700});
	symlinkSync(auth, path.join(codexHome, 'auth.json'));
	writeFileSync(
		path.join(codexHome, 'config.toml'),
		`[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`,
	);
	writeFileSync(
		path.join(repo, 'AGENTS.md'),
		'This is a disposable status fixture. Only perform the explicitly requested action. Do not inspect other directories, contact external services, or delegate. Keep replies brief.\n',
	);
	writeFileSync(
		path.join(repo, '.pappardelle.yml'),
		`version: 1
issue_tracker:
  provider: beads
companion_command: ''
list_view:
  layout: single_line
default_profile: codex-workspace
agent_profile: codex-rail
agent_profiles:
  codex-rail:
    command: codex
    args: --no-daemon --no-alt-screen --sandbox read-only --ask-for-approval on-request --config features.apps=false
    effort: low
profiles:
  codex-workspace:
    display_name: Codex workspace
    keywords: []
    agent_profile: codex-rail
`,
	);
	execFileSync('git', ['init', '--quiet', '--initial-branch', branch, repo]);
	execFileSync('git', [
		'-C',
		repo,
		'-c',
		'user.name=Fixture',
		'-c',
		'user.email=fixture@example.invalid',
		'commit',
		'--quiet',
		'--allow-empty',
		'-m',
		'Fixture',
	]);
	const command = shellQuoteStatus(path.join(project, 'dist/pappardelle'));
	tmux(
		outer,
		'-f',
		'/dev/null',
		'new-session',
		'-d',
		'-s',
		'tui',
		'-x',
		'180',
		'-y',
		'45',
		'-c',
		repo,
		command,
	);
	console.log(`Fixture ${root}; ${version}`);
	await expect('idle', /●/, 'agent profile launch shows native idle');
	agent = tmux(inner, 'list-sessions', '-F', '#{session_name}')
		.trim()
		.split('\n')
		.find(name => name.startsWith('agent-'));
	assert.ok(agent);
	assert.equal(
		createStateDaos({repo: path.basename(repo), stateDir}).spaceState.read(
			'main',
		)?.agentProfile?.name,
		'codex-rail',
	);
	await prompt(
		'Reply with only the two parts CODEX_RAIL_ and VERIFIED joined together without spaces. Do not use tools.',
	);
	await expect('working', /[·✢✳∗✻✽]/, 'real turn shows working spinner');
	await expect(['idle', 'done'], /●/, 'completed turn shows completion');
	assert.ok(
		tmux(inner, 'capture-pane', '-p', '-t', `=${agent}:`).includes(
			'CODEX_RAIL_VERIFIED',
		),
	);
	const approved = path.join(repo, 'approved.txt');
	const approvalCommand = `printf approved > ${shellQuoteStatus(approved)}`;
	execFileSync('shellcheck', ['-s', 'bash', '-'], {input: approvalCommand});
	await prompt(
		`Run exactly this shell command with sandbox_permissions="require_escalated" and ask me for approval: ${approvalCommand}. Do not use any other tools. After approval reply briefly.`,
	);
	await expect('blocked', /!/, 'approval shows attention indicator');
	await untilSeen(
		() => tmux(inner, 'capture-pane', '-p', '-t', `=${agent}:`),
		screen =>
			/Yes, proceed|Would you like to run|approve this command/.test(screen),
		'Codex approval dialog',
	);
	tmux(inner, 'send-keys', '-t', `=${agent}:`, 'Enter');
	await expect(['idle', 'done'], /●/, 'approval shows completion');
	assert.equal(readFileSync(approved, 'utf8'), 'approved');
	await prompt('/exit');
	await expect('unknown', /\?/, 'agent exit clears rail status');
	console.log(
		`Passed ${frames.length} TUI rail checks; evidence ${root}/codex-workspace-verification.json`,
	);
} finally {
	writeFileSync(
		path.join(root, 'codex-workspace-verification.json'),
		JSON.stringify({version, frames}, null, 2),
	);
	writeFileSync(
		path.join(root, 'codex-rail-transcript.md'),
		`# Installed ${version}: TUI rail\n\n` +
			frames
				.map(
					({scenario, frame, snapshot: state}) =>
						`## ${scenario}\n\nNative status: \`${state.info.status}\`\n\n\`\`\`text\n${frame.trimEnd()}\n\`\`\`\n`,
				)
				.join('\n'),
	);
	for (const socket of [outer, inner]) {
		try {
			tmux(socket, 'kill-server');
		} catch {}
	}
	rmSync(codexHome, {recursive: true, force: true});
	if (!process.argv.includes('--keep'))
		rmSync(root, {recursive: true, force: true});
}
