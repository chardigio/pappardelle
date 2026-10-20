import {execFileSync, spawnSync} from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import test, {type ExecutionContext} from 'ava';
import {shellQuoteStatus} from './program-status-monitor.ts';
import type {ProgramStatusSnapshot} from './program-status-monitor.ts';

const project = path.resolve(import.meta.dirname, '..');
const runtimeTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.skip;

function fixture(t: ExecutionContext, python: boolean, staleNode = false) {
	const root = realpathSync(mkdtempSync('/tmp/status-launch-'));
	const bin = path.join(root, 'bin');
	const repo = path.join(root, 'repo');
	const home = path.join(root, 'home');
	const socket = 'status-launch';
	for (const dir of [bin, repo, home, path.join(root, 'tmux')])
		mkdirSync(dir, {mode: 0o700});
	for (const command of [
		'tmux',
		'dirname',
		'git',
		'ps',
		...(python ? ['python3'] : []),
	]) {
		const binary = execFileSync('which', [command], {encoding: 'utf8'}).trim();
		symlinkSync(binary, path.join(bin, command));
	}
	if (staleNode)
		writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 77\n', {
			mode: 0o755,
		});
	const shell = path.join(root, 'shell');
	writeFileSync(
		shell,
		`#!/bin/sh\nPATH=${shellQuoteStatus(bin)}\nexport PATH\nPS1='FIXTURE> '\nexport PS1\nexec /bin/bash --noprofile --norc "$@"\n`,
		{mode: 0o755},
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		PATH: bin,
		SHELL: shell,
		TMUX_TMPDIR: path.join(root, 'tmux'),
		PAPPARDELLE_TMUX_SOCKET: socket,
		PAPPARDELLE_PROGRAM_STATUS_DIR: path.join(root, 'status'),
		PAPPARDELLE_CLAUDE_CONFIG_PATH: path.join(root, 'claude-config.json'),
		PAPPARDELLE_NODE: '/stale/inherited/node',
	};
	delete env['TMUX'];
	delete env['TMUX_PANE'];
	const tmux = (...args: string[]) =>
		execFileSync('tmux', ['-L', socket, ...args], {
			env,
			encoding: 'utf8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	t.teardown(() => {
		try {
			tmux('kill-server');
		} catch {}
		rmSync(root, {recursive: true, force: true});
	});
	execFileSync('git', ['init', '--quiet', repo]);
	const worker = path.join(root, 'launch.mjs');
	const launch = (
		launcher: 'tui' | 'shell',
		command: string,
		args = '',
		isClaude = false,
	) => {
		const profile = {
			name: 'fixture',
			command,
			args,
			isClaude,
			resumeArgs: '',
			model: '',
			effort: '',
		};
		writeFileSync(
			worker,
			`
import {execFileSync} from 'node:child_process';
import {ensureAgentSession} from ${JSON.stringify(pathToFileURL(path.join(project, 'dist/tmux.js')).href)};
import {buildSpawnEnv} from ${JSON.stringify(pathToFileURL(path.join(project, 'dist/spawn-env.js')).href)};
const profile = ${JSON.stringify(profile)};
if (${JSON.stringify(launcher)} === 'tui') {
  if (!await ensureAgentSession('TEST-1', process.cwd(), false, undefined, profile)) throw new Error('Launch failed');
} else {
  execFileSync('/bin/bash', [${JSON.stringify(path.join(project, 'scripts/start-agent-session.sh'))},
    '--issue-key', 'TEST-1', '--repo-name', 'repo', '--worktree', process.cwd(), '--companion-command', '',
    '--agent-command', profile.command, '--agent-args', profile.args, '--agent-is-claude', String(profile.isClaude),
    '--agent-profile', profile.name, '--agent-resume-args', ''], {env: buildSpawnEnv(process.cwd(), process.cwd())});
}
`,
		);
		execFileSync(process.execPath, [worker], {
			cwd: repo,
			env,
			timeout: 15000,
			stdio: 'pipe',
		});
	};
	const read = (name: string) =>
		JSON.parse(readFileSync(path.join(root, name), 'utf8')) as Record<
			string,
			unknown
		>;
	const status = () => {
		const dir = path.join(root, 'status', 'repo');
		try {
			return readdirSync(dir)
				.filter(file => file.endsWith('.json'))
				.map(
					file =>
						JSON.parse(
							readFileSync(path.join(dir, file), 'utf8'),
						) as ProgramStatusSnapshot,
				)
				.find(value => value.key === 'TEST-1');
		} catch {
			return undefined;
		}
	};
	const blockedAgent = path.join(root, 'agent');
	writeFileSync(
		blockedAgent,
		`#!/bin/sh
printf '\\033]7501;state=blocked:app=fixture\\007'
printf launched > ${shellQuoteStatus(path.join(root, 'started'))}
IFS= read -r reply
printf '%s' "$reply" > ${shellQuoteStatus(path.join(root, 'reply'))}
`,
		{mode: 0o755},
	);
	return {root, bin, launch, read, status, tmux, blockedAgent};
}

async function until(read: () => boolean, label: string) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			if (read()) return;
		} catch {}
		await delay(20);
	}
	throw new Error(`Timed out: ${label}`);
}

for (const launcher of ['tui', 'shell'] as const) {
	for (const isClaude of [true, false]) {
		runtimeTest(
			`${launcher} proxy records the primary session for a ${isClaude ? 'Claude' : 'Codex'} profile and rejects a nested agent`,
			async t => {
				const h = fixture(t, true);
				const python = execFileSync('which', ['python3'], {
					encoding: 'utf8',
				}).trim();
				const args = [
					path.join(
						project,
						'integration-tests/program-status-agent-fixture.py',
					),
					'recording',
					h.root,
					String(isClaude),
				]
					.map(value => shellQuoteStatus(value))
					.join(' ');
				h.launch(launcher, python, args, isClaude);
				await until(
					() => Boolean(h.read('recording.json')),
					'agent hook results',
				);
				t.like(h.read('recording.json'), {
					primary: true,
					nested: false,
					sessions: {fixture: 'primary'},
				});
				t.truthy(h.read('recording.json')['proxy_pid']);
			},
		);
	}
	runtimeTest(
		`${launcher} starts the agent and preserves input and initial status without Python`,
		async t => {
			const h = fixture(t, false);
			h.launch(launcher, h.blockedAgent);
			await until(
				() => h.status()?.info.status === 'blocked',
				'initial blocked report without Python',
			);
			t.is(readFileSync(path.join(h.root, 'started'), 'utf8'), 'launched');
			h.tmux('send-keys', '-t', '=agent-repo-TEST-1:', '-l', 'agent-input');
			h.tmux('send-keys', '-t', '=agent-repo-TEST-1:', 'Enter');
			await until(
				() =>
					readFileSync(path.join(h.root, 'reply'), 'utf8') === 'agent-input',
				'agent receives input',
			);
			await until(
				() =>
					h
						.tmux('capture-pane', '-p', '-t', '=agent-repo-TEST-1:')
						.includes('FIXTURE>'),
				'login shell after agent exit',
			);
			h.tmux(
				'send-keys',
				'-t',
				'=agent-repo-TEST-1:',
				'-l',
				`printf shell-ok > ${shellQuoteStatus(path.join(h.root, 'shell-reply'))}`,
			);
			h.tmux('send-keys', '-t', '=agent-repo-TEST-1:', 'Enter');
			await until(
				() =>
					readFileSync(path.join(h.root, 'shell-reply'), 'utf8') === 'shell-ok',
				'responsive login shell',
			);
			t.pass();
		},
	);
}

for (const staleNode of [false, true]) {
	runtimeTest(
		`shell launch captures its first report using the selected Node with ${staleNode ? 'a stale' : 'no'} PATH Node`,
		async t => {
			const h = fixture(t, true, staleNode);
			h.launch('shell', h.blockedAgent);
			await until(
				() => h.status()?.info.status === 'blocked',
				'first blocked report using selected Node',
			);
			t.true(h.status()?.authoritative);
			t.is(h.status()?.info.app, 'fixture');
		},
	);
}
