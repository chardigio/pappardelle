import {execFileSync, spawnSync} from 'node:child_process';
import {
	existsSync,
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

function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

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
		PAPPARDELLE_BUN: '/stale/inherited/bun',
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
	t.teardown(async () => {
		let panePids: number[] = [];
		try {
			panePids = tmux('list-panes', '-a', '-F', '#{pane_pid}')
				.split('\n')
				.filter(Boolean)
				.map(Number);
			tmux('kill-server');
		} catch {}
		// kill-server returns before pane processes exit, and an exiting pane can
		// still write a status file while the directory is being removed.
		const deadline = Date.now() + 5000;
		while (panePids.some(pid => isAlive(pid)) && Date.now() < deadline) {
			await delay(50);
		}
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 20,
			retryDelay: 100,
		});
	});
	execFileSync('git', ['init', '--quiet', repo]);
	const worker = path.join(root, 'launch.mjs');
	const launch = (
		launcher: 'tui' | 'shell' | 'compiled-shell',
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
import {ensureAgentSession, initTmuxState} from ${JSON.stringify(pathToFileURL(path.join(project, 'dist/tmux.js')).href)};
import {createStateDaos} from ${JSON.stringify(pathToFileURL(path.join(project, 'dist/state-daos.js')).href)};
import {buildSpawnEnv} from ${JSON.stringify(pathToFileURL(path.join(project, 'dist/spawn-env.js')).href)};
const profile = ${JSON.stringify(profile)};
initTmuxState(createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(path.join(root, 'state'))}}));
if (${JSON.stringify(launcher)} === 'tui') {
  if (!await ensureAgentSession('TEST-1', process.cwd(), false, undefined, profile)) throw new Error('Launch failed');
} else {
  execFileSync('/bin/bash', [${JSON.stringify(path.join(project, 'scripts/start-agent-session.sh'))},
    '--issue-key', 'TEST-1', '--repo-name', 'repo', '--worktree', process.cwd(), '--companion-command', '',
    '--agent-command', profile.command, '--agent-args', profile.args, '--agent-is-claude', String(profile.isClaude),
    '--agent-profile', profile.name, '--agent-resume-args', ''], {env: {...buildSpawnEnv(process.cwd(), process.cwd()), ...(${JSON.stringify(launcher)} === 'compiled-shell' ? {PAPPARDELLE_BUN: '', PAPPARDELLE_EXECUTABLE: ${JSON.stringify(path.join(project, 'dist/pappardelle'))}} : {})}});
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
printf '%s' "\${PI_PROGRAM_STATUS:-}" > ${shellQuoteStatus(path.join(root, 'pi-status'))}
{ /usr/bin/yes | /usr/bin/head -n 1 >/dev/null; } 2> ${shellQuoteStatus(path.join(root, 'pipeline-errors'))}
printf '%s' "$$" > ${shellQuoteStatus(path.join(root, 'agent-pid'))}
printf launched > ${shellQuoteStatus(path.join(root, 'started'))}
printf '\\033]7501;state=blocked:app=fixture\\007'
IFS= read -r reply
printf '%s' "$reply" > ${shellQuoteStatus(path.join(root, 'reply'))}
`,
		{mode: 0o755},
	);
	const failRelease = (afterDelivery: boolean) => {
		const realTmux = realpathSync(path.join(bin, 'tmux'));
		const failed = path.join(root, 'failed-release');
		const script = `#!/bin/bash
for arg in "$@"; do
    if [[ "$arg" == *wait-for* && "$arg" == *-S* && ! -f ${shellQuoteStatus(failed)} ]]; then
        printf failed > ${shellQuoteStatus(failed)}
        ${afterDelivery ? `${shellQuoteStatus(realTmux)} "$@"` : ':'}
        exit 42
    fi
done
exec ${shellQuoteStatus(realTmux)} "$@"
`;
		execFileSync('shellcheck', ['-s', 'bash', '-'], {input: script});
		rmSync(path.join(bin, 'tmux'));
		writeFileSync(path.join(bin, 'tmux'), script, {mode: 0o755});
	};
	return {root, bin, launch, read, status, tmux, blockedAgent, failRelease};
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
	for (const state of ['working', 'blocked', 'done', 'error']) {
		runtimeTest(
			`${launcher} ${state === 'working' || state === 'blocked' ? 'clears' : 'retains'} ${state} after agent death`,
			async t => {
				const h = fixture(t, false);
				const agent = path.join(h.root, 'exit-agent.mjs');
				const pidFile = path.join(h.root, 'pid');
				writeFileSync(
					agent,
					`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.stdout.write('\\x1b]7501;state=${state}:app=fixture\\x07');process.stdin.resume();`,
				);
				h.launch(launcher, process.execPath, shellQuoteStatus(agent));
				await until(
					() => h.status()?.info.status === state,
					'initial native report',
				);
				process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
				const expected =
					state === 'working' || state === 'blocked' ? 'unknown' : state;
				await until(
					() =>
						h
							.tmux('capture-pane', '-p', '-t', '=agent-repo-TEST-1:')
							.includes('FIXTURE>'),
					'fallback shell',
				);
				await until(
					() => h.status()?.info.status === expected,
					'status after agent exit',
				);
				t.is(
					h
						.tmux(
							'display-message',
							'-p',
							'-t',
							'=agent-repo-TEST-1:',
							'#{pane_dead}',
						)
						.trim(),
					'0',
				);
				t.true(h.status()?.authoritative);
			},
		);
	}
	for (const afterDelivery of [false, true]) {
		runtimeTest(
			`${launcher} recovers startup after a release error ${afterDelivery ? 'after' : 'before'} delivery`,
			async t => {
				const h = fixture(t, false);
				h.failRelease(afterDelivery);
				t.throws(() => h.launch(launcher, h.blockedAgent));
				if (afterDelivery)
					await until(
						() => existsSync(path.join(h.root, 'started')),
						'delivered gate starts agent',
					);
				else t.false(existsSync(path.join(h.root, 'started')));
				const before = afterDelivery
					? readFileSync(path.join(h.root, 'agent-pid'), 'utf8')
					: undefined;
				h.launch(launcher, h.blockedAgent);
				await until(
					() => h.status()?.info.status === 'blocked',
					'recovered initial report',
				);
				t.is(
					h
						.tmux(
							'show-option',
							'-qv',
							'-t',
							'=agent-repo-TEST-1:',
							'@pappardelle_startup_gate',
						)
						.trim(),
					'',
				);
				if (before)
					t.is(readFileSync(path.join(h.root, 'agent-pid'), 'utf8'), before);
			},
		);
	}
	for (const isClaude of [true, false]) {
		runtimeTest(
			`${launcher} records the primary session for a ${isClaude ? 'Claude' : 'Codex'} profile and rejects a nested agent`,
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
					sessions: {fixture: {session_id: 'primary'}},
				});
			},
		);
	}
	runtimeTest(
		`${launcher} enables Pi reporting and preserves pipeline signals with Python installed`,
		async t => {
			const h = fixture(t, true);
			h.launch(launcher, h.blockedAgent);
			await until(
				() =>
					h.status()?.info.status === 'blocked' &&
					readFileSync(path.join(h.root, 'pi-status'), 'utf8') !== '',
				'initial status and Pi environment',
			);
			t.is(readFileSync(path.join(h.root, 'pi-status'), 'utf8'), '1');
			t.is(readFileSync(path.join(h.root, 'pipeline-errors'), 'utf8'), '');
		},
	);
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

runtimeTest(
	'TUI launch bypasses a default shell that cannot parse its launch syntax',
	async t => {
		const h = fixture(t, false);
		const shell = path.join(h.root, 'non-posix-shell');
		const script = '#!/bin/sh\nexit 42\n';
		execFileSync('shellcheck', ['-s', 'sh', '-'], {input: script});
		writeFileSync(shell, script, {mode: 0o755});
		h.tmux('new-session', '-d', '-s', 'seed', '/bin/sleep', '300');
		h.tmux('set-option', '-g', 'default-shell', shell);
		h.launch('tui', h.blockedAgent);
		await until(
			() => h.status()?.info.status === 'blocked',
			'first native report without default-shell parsing',
		);
		t.true(h.status()?.authoritative);
	},
);

for (const staleNode of [false, true]) {
	runtimeTest(
		`shell launch captures its first report using the selected Bun with ${staleNode ? 'a stale' : 'no'} PATH Node`,
		async t => {
			const h = fixture(t, true, staleNode);
			h.launch('shell', h.blockedAgent);
			await until(
				() => h.status()?.info.status === 'blocked',
				'first blocked report using selected Bun',
			);
			t.true(h.status()?.authoritative);
			t.is(h.status()?.info.app, 'fixture');
		},
	);
}

runtimeTest(
	'compiled monitor captures shell reports without Bun or Node on PATH',
	async t => {
		const h = fixture(t, true, true);
		h.launch('compiled-shell', h.blockedAgent);
		await until(
			() => h.status()?.info.status === 'blocked',
			'first report through the embedded monitor',
		);
		t.true(h.status()?.authoritative);
		t.is(h.status()?.info.app, 'fixture');
		h.tmux('kill-session', '-t', '=agent-repo-TEST-1');
		await until(
			() => h.status()?.exited === true,
			'compiled monitor retires after pane exit',
		);
		t.true(h.status()?.exited);
	},
);
