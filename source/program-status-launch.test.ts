import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
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
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {killProcessesNaming} from '../test/helpers/processes.ts';
import {sqliteRun} from '../test/helpers/state.ts';
import {
	serveTestHub,
	subscribeRaw,
	type RawConnection,
} from '../test/helpers/status-daemon.ts';
import {shellQuoteStatus} from './program-status-monitor.ts';
import type {ProgramStatusSnapshot} from './program-status-monitor.ts';

const project = path.resolve(import.meta.dirname, '..');
const runtimeTest = spawnSync('tmux', ['-V']).status === 0 ? test : test.skip;

function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function fixture(python: boolean, staleNode = false) {
	const root = realpathSync(mkdtempSync(`${tmpdir()}/status-launch-`));
	const bin = path.join(root, 'bin');
	const repo = path.join(root, 'repo');
	const home = path.join(root, 'home');
	const socket = 'status-launch';
	// The agent's hook finds the stores under its home directory.
	const stateDir = path.join(home, '.pappardelle');
	const statusSocket = path.join(stateDir, 'status-1.sock');
	for (const dir of [bin, repo, home, stateDir, path.join(root, 'tmux')])
		mkdirSync(dir, {mode: 0o700});
	// With the flag on the monitors send to the status daemon. Its hub is
	// served from here, so that none of them starts a daemon process.
	let rail: RawConnection | undefined;
	if (sqliteRun) {
		serveTestHub(statusSocket);
		void subscribeRaw(statusSocket, 'repo').then(connection => {
			rail = connection;
		});
	}

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
		// The shell launcher's `attach` has no state directory to derive it from.
		PAPPARDELLE_STATUS_SOCKET: statusSocket,
		PAPPARDELLE_CLAUDE_CONFIG_PATH: path.join(root, 'claude-config.json'),
		PAPPARDELLE_BUN: '/stale/inherited/bun',
	};
	const tmux = (...args: string[]) =>
		execFileSync('tmux', ['-L', socket, ...args], {
			env,
			encoding: 'utf8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	teardown(async () => {
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

		// A monitor that outlived its pane would start a daemon once the hub
		// served here is gone.
		killProcessesNaming(statusSocket);
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
import {ensureAgentSession, initTmuxState} from ${JSON.stringify(pathToFileURL(path.join(project, 'source/tmux.ts')).href)};
import {createStateDaos} from ${JSON.stringify(pathToFileURL(path.join(project, 'source/state-daos.ts')).href)};
import {buildSpawnEnv} from ${JSON.stringify(pathToFileURL(path.join(project, 'source/spawn-env.ts')).href)};
import {newSpaceIdentity} from ${JSON.stringify(pathToFileURL(path.join(project, 'source/space-identity.ts')).href)};
import {statusSocket} from ${JSON.stringify(pathToFileURL(path.join(project, 'source/program-status-monitor.ts')).href)};
const profile = ${JSON.stringify(profile)};
const daos = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(stateDir)}});
initTmuxState(daos);
await daos.spaceIdentities.record(newSpaceIdentity({repo: 'repo', key: 'TEST-1', worktreePath: process.cwd(), socket: statusSocket()}));
if (${JSON.stringify(launcher)} === 'tui') {
  if (!await ensureAgentSession('TEST-1', process.cwd(), false, undefined, profile)) throw new Error('Launch failed');
} else {
  // idow records the agent profile before it starts the session.
  await daos.spaceState.write('TEST-1', {agentProfile: {name: profile.name, isClaude: profile.isClaude}});
  execFileSync('/bin/bash', [${JSON.stringify(path.join(project, 'scripts/start-agent-session.sh'))},
    '--issue-key', 'TEST-1', '--repo-name', 'repo', '--worktree', process.cwd(),
    '--agent-session', 'agent-repo-TEST-1', '--companion-session', 'companion-repo-TEST-1', '--legacy-agent-session', 'claude-repo-TEST-1', '--companion-command', '',
    '--agent-command', profile.command, '--agent-args', profile.args, '--agent-is-claude', String(profile.isClaude),
    '--agent-resume-args', ''], {env: {...buildSpawnEnv(process.cwd(), {mainRepoRoot: process.cwd(), registerSpace: false}), ...(${JSON.stringify(launcher)} === 'compiled-shell' ? {PAPPARDELLE_BUN: '', PAPPARDELLE_EXECUTABLE: ${JSON.stringify(path.join(project, 'dist/pappardelle'))}} : {})}});
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
		if (sqliteRun)
			return rail?.messages
				.flatMap(message =>
					message.type === 'state'
						? message.snapshots
						: message.type === 'snapshot'
							? [message.snapshot]
							: [],
				)
				.findLast(value => value.key === 'TEST-1');
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
			async () => {
				const h = fixture(false);
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
				expect(
					h
						.tmux(
							'display-message',
							'-p',
							'-t',
							'=agent-repo-TEST-1:',
							'#{pane_dead}',
						)
						.trim(),
				).toBe('0');
				expect(h.status()?.authoritative).toBe(true);
			},
		);
	}
	for (const afterDelivery of [false, true]) {
		runtimeTest(
			`${launcher} recovers startup after a release error ${afterDelivery ? 'after' : 'before'} delivery`,
			async () => {
				const h = fixture(false);
				h.failRelease(afterDelivery);
				expect(() => h.launch(launcher, h.blockedAgent)).toThrow();
				if (afterDelivery)
					await until(
						() => existsSync(path.join(h.root, 'started')),
						'delivered gate starts agent',
					);
				else expect(existsSync(path.join(h.root, 'started'))).toBe(false);
				const before = afterDelivery
					? readFileSync(path.join(h.root, 'agent-pid'), 'utf8')
					: undefined;
				h.launch(launcher, h.blockedAgent);
				await until(
					() => h.status()?.info.status === 'blocked',
					'recovered initial report',
				);
				expect(
					h
						.tmux(
							'show-option',
							'-qv',
							'-t',
							'=agent-repo-TEST-1:',
							'@pappardelle_startup_gate',
						)
						.trim(),
				).toBe('');
				if (before)
					expect(readFileSync(path.join(h.root, 'agent-pid'), 'utf8')).toBe(
						before,
					);
			},
		);
	}
	for (const isClaude of [true, false]) {
		runtimeTest(
			`${launcher} records the primary session for a ${isClaude ? 'Claude' : 'Codex'} profile and rejects a nested agent`,
			async () => {
				const h = fixture(true);
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
				expect(h.read('recording.json')).toMatchObject({
					primary: true,
					nested: false,
					sessions: {fixture: {session_id: 'primary'}},
				});
			},
		);
	}
	runtimeTest(
		`${launcher} enables Pi reporting and preserves pipeline signals with Python installed`,
		async () => {
			const h = fixture(true);
			h.launch(launcher, h.blockedAgent);
			await until(
				() =>
					h.status()?.info.status === 'blocked' &&
					readFileSync(path.join(h.root, 'pi-status'), 'utf8') !== '',
				'initial status and Pi environment',
			);
			expect(readFileSync(path.join(h.root, 'pi-status'), 'utf8')).toBe('1');
			expect(readFileSync(path.join(h.root, 'pipeline-errors'), 'utf8')).toBe(
				'',
			);
		},
	);
	runtimeTest(
		`${launcher} starts the agent and preserves input and initial status without Python`,
		async () => {
			const h = fixture(false);
			h.launch(launcher, h.blockedAgent);
			await until(
				() => h.status()?.info.status === 'blocked',
				'initial blocked report without Python',
			);
			expect(readFileSync(path.join(h.root, 'started'), 'utf8')).toBe(
				'launched',
			);
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
			expect().pass();
		},
	);
}

runtimeTest(
	'TUI launch bypasses a default shell that cannot parse its launch syntax',
	async () => {
		const h = fixture(false);
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
		expect(h.status()?.authoritative).toBe(true);
	},
);

for (const staleNode of [false, true]) {
	runtimeTest(
		`shell launch captures its first report using the selected Bun with ${staleNode ? 'a stale' : 'no'} PATH Node`,
		async () => {
			const h = fixture(true, staleNode);
			h.launch('shell', h.blockedAgent);
			await until(
				() => h.status()?.info.status === 'blocked',
				'first blocked report using selected Bun',
			);
			expect(h.status()?.authoritative).toBe(true);
			expect(h.status()?.info.app).toBe('fixture');
		},
	);
}

runtimeTest(
	'compiled monitor captures shell reports without Bun or Node on PATH',
	async () => {
		const h = fixture(true, true);
		h.launch('compiled-shell', h.blockedAgent);
		await until(
			() => h.status()?.info.status === 'blocked',
			'first report through the embedded monitor',
		);
		expect(h.status()?.authoritative).toBe(true);
		expect(h.status()?.info.app).toBe('fixture');
		h.tmux('kill-session', '-t', '=agent-repo-TEST-1');
		await until(
			() => h.status()?.exited === true,
			'compiled monitor retires after pane exit',
		);
		expect(h.status()?.exited).toBe(true);
	},
);
