import {Database} from 'bun:sqlite';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {gatherSpaces} from './spaces-command.ts';
import {createStateDaos, type StateDaos} from './state-daos.ts';
import {closeStateDb, stateDbPath, statusSocketPath} from './state-db.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {isAlive} from '../test/helpers/processes.ts';
import {sendHookEvent, serveTestDaemon} from '../test/helpers/status-daemon.ts';
import {until} from '../test/helpers/wait.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');
// Long enough for a CLI that has begun to wait for its agent to have tried
// the status socket once and found nothing there.
const FIRST_CONNECT_ATTEMPT_MS = 500;
const useStandalone = process.env['PAPPARDELLE_TEST_STANDALONE'] === '1';

function fixture(provider = 'jira') {
	const root = tempDir('papp-cli-space-');
	const repo = path.join(root, 'project');
	const home = path.join(root, 'home');
	const install = path.join(root, 'install');
	fs.mkdirSync(repo);
	fs.mkdirSync(home);
	fs.mkdirSync(path.join(install, 'scripts'), {recursive: true});
	fs.copyFileSync(
		path.join(projectRoot, 'scripts', 'builtin-agents.json'),
		path.join(install, 'scripts', 'builtin-agents.json'),
	);
	const directory = useStandalone ? 'dist' : 'source';
	fs.cpSync(path.join(projectRoot, directory), path.join(install, directory), {
		recursive: true,
		filter: file => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
	});
	const cli = useStandalone
		? [path.join(install, 'dist/pappardelle')]
		: [process.execPath, path.join(install, 'source/cli.tsx')];
	fs.symlinkSync(
		path.join(projectRoot, 'node_modules'),
		path.join(install, 'node_modules'),
	);
	fs.writeFileSync(path.join(install, 'package.json'), '{"type":"module"}');
	execFileSync('git', ['init', '--quiet', repo]);
	fs.writeFileSync(
		path.join(repo, '.pappardelle.yml'),
		`version: 1
workspace_aware_agents: true
team_prefix: STE
issue_tracker:
  provider: ${provider}
  base_url: https://example.invalid
profiles:
  test:
    display_name: Test
    tracker_projects: [ste]
`,
	);
	const idow = path.join(install, 'scripts', 'idow');
	const record = path.join(root, 'idow.json');
	fs.writeFileSync(
		idow,
		`#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(process.env.IDOW_TEST_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  projectRoot: process.env.PAPPARDELLE_PROJECT_ROOT,
  mainRepoRoot: process.env.PAPPARDELLE_MAIN_REPO_ROOT,
  stdin: fs.readFileSync(0, 'utf8'),
  stdinIsTTY: process.stdin.isTTY ?? false,
}));
if (process.env.IDOW_TEST_PID_FILE) fs.writeFileSync(process.env.IDOW_TEST_PID_FILE, String(process.pid));
if (process.env.IDOW_TEST_KEEP_ALIVE) setTimeout(() => {}, 30000);
process.stderr.write('idow diagnostic\\n');
const output = process.env.IDOW_TEST_OUTPUT ?? 'Workspace ' + process.argv.at(-1) + ' is ready!\\n';
process.stdout.write('x'.repeat(Number(process.env.IDOW_TEST_BYTES ?? 0)));
const split = Math.floor(output.length / 2);
process.stdout.write(output.slice(0, split));
setTimeout(() => {
  process.stdout.write(output.slice(split), () => {
    if (process.env.IDOW_TEST_SIGNAL) process.kill(process.pid, 'SIGTERM');
    else process.exitCode = Number(process.env.IDOW_TEST_STATUS ?? 0);
  });
}, 30);
`,
		{mode: 0o755},
	);
	const stateDir = path.join(home, '.pappardelle');
	let daos: StateDaos | undefined;
	/** The stores the CLI records to, open in this process too. */
	const stores = (): StateDaos => {
		if (daos) return daos;
		const opened = createStateDaos({
			repo: 'project',
			stateDir,
			home,
			mainRoot: () => repo,
		});
		teardown(() => {
			opened.disconnectStatusDaemon();
			closeStateDb(stateDbPath(stateDir));
		});
		daos = opened;
		return opened;
	};
	const env = {
		...process.env,
		HOME: home,
		// The standalone executable unpacks its native libraries here and never
		// removes them.
		TMPDIR: root,
		PAPPARDELLE_PROJECT_ROOT: repo,
		PAPPARDELLE_MAIN_REPO_ROOT: repo,
		IDOW_TEST_RECORD: record,
	};
	const start = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
		const child = spawn(cli[0]!, [...cli.slice(1), ...args], {
			cwd: repo,
			env: {...env, ...overrides},
			stdio: 'pipe',
		});
		teardown(() => child.kill());
		return child;
	};
	const run = async (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
		const child = start(args, overrides);
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.stdin.end('2\n');
		const [code, signal] = await once(child, 'close');
		return {code, signal, stdout, stderr};
	};
	const readRegistry = (): string[] => stores().registry.openSpaces();
	const readRecord = () =>
		JSON.parse(fs.readFileSync(record, 'utf8')) as {
			args: string[];
			cwd: string;
			projectRoot: string;
			mainRepoRoot: string;
			stdin: string;
			stdinIsTTY: boolean;
		};
	const seed = async () => stores().registry.add('STE-1');
	/**
	 * Hold the database's write lock from another connection, as a process
	 * in the middle of a write does. Returns its release.
	 */
	const holdWriteLock = () => {
		const db = new Database(stateDbPath(stateDir));
		db.run('BEGIN IMMEDIATE');
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			db.run('COMMIT');
			db.close();
		};
	};
	/**
	 * A worktree on disk with no stored identity, as a space closed before
	 * identities were stored has it.
	 */
	const worktreeOnly = (key: string) => {
		fs.mkdirSync(path.join(home, '.worktrees', 'project', key), {
			recursive: true,
		});
	};
	/** A worktree an earlier idow run created and recorded. */
	const existingWorktree = async (key: string) => {
		const worktreePath = path.join(home, '.worktrees', 'project', key);
		fs.mkdirSync(worktreePath, {recursive: true});
		await stores().spaceIdentities.record(
			newSpaceIdentity({
				repo: 'project',
				key,
				worktreePath,
				socket: 'pappardelle_inner',
			}),
		);
	};
	return {
		root,
		repo,
		home,
		install,
		cli,
		env,
		idow,
		record,
		stores,
		start,
		run,
		readRegistry,
		readRecord,
		seed,
		holdWriteLock,
		existingWorktree,
		worktreeOnly,
	};
}

test('CLI saves a normalized issue from a non-TTY sous-chef invocation', async () => {
	const f = fixture();
	const result = await f.run(['20']);
	expect(result.code).toBe(0);
	expect(f.readRegistry()).toStrictEqual(['STE-20']);
	expect(f.readRecord()).toStrictEqual({
		args: ['STE-20'],
		cwd: f.repo,
		projectRoot: f.repo,
		mainRepoRoot: f.repo,
		stdin: '2\n',
		stdinIsTTY: false,
	});
	expect(result.stdout.includes('Workspace STE-20 is ready!')).toBe(true);
	expect(result.stderr.includes('idow diagnostic')).toBe(true);
	const spaces = await gatherSpaces({
		repoName: 'project',
		...f.stores(),
		home: f.home,
		fetchTitles: async () => new Map(),
		gitSummary: async () => null,
	});
	expect(
		'error' in spaces ? spaces.error : spaces.spaces.map(space => space.name),
	).toStrictEqual(['STE-20']);
});

// A CLI verb never starts the daemon. The agent's pane monitor does, which
// can be after `open --wait` has begun to wait.
test('CLI --wait begun before any status daemon runs succeeds once one starts and the agent reports to it', async () => {
	const f = fixture();
	await f.existingWorktree('STE-20');
	const socketPath = statusSocketPath(path.join(f.home, '.pappardelle'));
	const child = f.start(['--resume', '--wait', 'STE-20']);
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});
	child.stdin.end('2\n');
	const closed = once(child, 'close');
	await until(() => stdout.includes('Workspace STE-20 is ready!'), {
		what: 'idow to finish',
		timeoutMs: 20_000,
	});
	await delay(FIRST_CONNECT_ATTEMPT_MS);
	expect(child.exitCode, stderr).toBe(null);
	expect(fs.existsSync(socketPath)).toBe(false);

	await serveTestDaemon(socketPath);
	await sendHookEvent(socketPath, {
		sessionId: 'session',
		workspaceName: 'project-STE-20',
		status: 'waiting_for_input',
		event: 'SessionStart',
		cwd: path.join(f.home, '.worktrees', 'project', 'STE-20'),
		lastUpdate: Date.now(),
	});

	const [code] = await closed;
	expect(code, stderr).toBe(0);
});

test("space_open over MCP keeps idow's output off the protocol channel", async () => {
	const f = fixture();
	const client = new Client({name: 'test', version: '1'});
	// This suite may itself run inside a space.
	const env = Object.fromEntries(
		Object.entries(f.env).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined && entry[0] !== 'PAPPARDELLE_SPACE',
		),
	);
	await client.connect(
		new StdioClientTransport({
			command: f.cli[0]!,
			args: [...f.cli.slice(1), 'mcp'],
			cwd: f.repo,
			env: {...env, IDOW_TEST_BYTES: '200000'},
			stderr: 'ignore',
		}),
	);
	teardown(async () => client.close());

	const result = await client.callTool({
		name: 'space_open',
		arguments: {input: 'STE-20'},
	});

	expect(result.isError).toBeFalsy();
	const [output] = result.content as Array<{text: string}>;
	expect(output!.text.endsWith('Workspace STE-20 is ready!')).toBe(true);
	expect(f.readRecord().args).toStrictEqual(['STE-20']);
	expect(f.readRegistry()).toStrictEqual(['STE-20']);
	const {tools} = await client.listTools();
	expect(tools.length > 0).toBe(true);
});

test('CLI resumes with the flag first and preserves existing spaces without duplicates', async () => {
	const f = fixture();
	await f.seed();
	for (const argv of [
		['--resume', 'ste-20'],
		['STE-20', '--resume'],
	]) {
		const result = await f.run(argv);
		expect(result.code).toBe(0);
		expect(f.readRecord().args).toStrictEqual(['--resume', 'STE-20']);
		expect(f.readRegistry()).toStrictEqual(['STE-1', 'STE-20']);
	}
});

test('CLI forwards an explicit profile before a workspace description', async () => {
	const f = fixture();
	const input = 'fix auth bug';
	for (const args of [
		['--profile', 'test', input],
		[input, '--profile', 'test'],
	]) {
		const result = await f.run(args, {
			IDOW_TEST_OUTPUT: 'Workspace STE-99 is ready!\n',
		});
		expect(result.code).toBe(0);
		expect(f.readRecord().args).toStrictEqual(['--profile', 'test', input]);
		expect(f.readRegistry()).toStrictEqual(['STE-99']);
	}
});

test('CLI orders resume before the forced profile for an existing worktree', async () => {
	const f = fixture();
	f.worktreeOnly('STE-20');
	for (const args of [
		['--profile', 'test', 'STE-20'],
		['--resume', '--profile', 'test', 'STE-20'],
	]) {
		const result = await f.run(args);
		expect(result.code).toBe(0);
		expect(f.readRecord().args).toStrictEqual([
			'--resume',
			'--profile',
			'test',
			'STE-20',
		]);
		expect(f.readRegistry()).toStrictEqual(['STE-20']);
	}
});

test('CLI forwards an agent profile to idow after the profile, where idow reads it', async () => {
	const f = fixture();
	fs.appendFileSync(
		path.join(f.repo, '.pappardelle.yml'),
		'agent_profiles:\n  codex:\n    command: codex\n',
	);
	f.worktreeOnly('STE-20');
	const result = await f.run([
		'--agent-profile',
		'codex',
		'--profile',
		'test',
		'STE-20',
	]);
	expect(result.code, result.stderr).toBe(0);
	expect(f.readRecord().args).toStrictEqual([
		'--resume',
		'--profile',
		'test',
		'--agent-profile',
		'codex',
		'STE-20',
	]);
	expect(f.readRegistry()).toStrictEqual(['STE-20']);
});

test('CLI rejects an unknown agent profile with the valid names before running idow', async () => {
	const f = fixture();
	fs.appendFileSync(
		path.join(f.repo, '.pappardelle.yml'),
		'agent_profiles:\n  codex:\n    command: codex\n',
	);
	const result = await f.run(['--agent-profile', 'codx', 'STE-20']);
	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(
		/Unknown agent profile "codx"\. Agent profiles: claude, codex/,
	);
	expect(fs.existsSync(f.record)).toBe(false);
	expect(f.readRegistry()).toStrictEqual([]);
});

test('CLI rejects an agent profile with no workspace input instead of starting the TUI', async () => {
	const f = fixture();
	for (const [args, message] of [
		[['--agent-profile', 'claude'], /Usage: pappardelle --agent-profile/],
		[
			['--agent-profile=', 'STE-20'],
			/--agent-profile needs an agent profile name/,
		],
	] as const) {
		const result = await f.run([...args, '--no-layout']);
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(message);
		expect(fs.existsSync(f.record)).toBe(false);
	}
});

test('CLI warns, and still succeeds, when idow leaves a running agent on its old profile', async () => {
	const f = fixture();
	const result = await f.run(['--agent-profile', 'claude', 'STE-20'], {
		IDOW_TEST_OUTPUT:
			'PAPPARDELLE_AGENT_PROFILE_OVERRIDE=skipped\nWorkspace STE-20 is ready!\n',
	});
	expect(result.code, result.stderr).toBe(0);
	expect(result.stderr).toMatch(
		/STE-20: agent already running, claude not applied/,
	);
	expect(result.stdout.includes('PAPPARDELLE_AGENT_PROFILE_OVERRIDE')).toBe(
		false,
	);
	expect(result.stdout).toMatch(/Workspace STE-20 is ready!/);
	expect(f.readRegistry()).toStrictEqual(['STE-20']);
});

test('CLI uses the forced profile team prefix when normalizing a bare issue number', async () => {
	const f = fixture();
	fs.appendFileSync(
		path.join(f.repo, '.pappardelle.yml'),
		'    team_prefix: APP\n',
	);
	const result = await f.run(['--profile', 'test', '20']);
	expect(result.code).toBe(0);
	expect(f.readRecord().args).toStrictEqual(['--profile', 'test', 'APP-20']);
	expect(f.readRegistry()).toStrictEqual(['APP-20']);
});

test('CLI rejects missing profile names and missing workspace input before running idow', async () => {
	const f = fixture();
	for (const args of [
		['--profile'],
		['--profile', 'test'],
		['--profile=', 'STE-20'],
	]) {
		const result = await f.run([...args, '--no-layout']);
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/Usage: pappardelle --profile/);
		expect(fs.existsSync(f.record)).toBe(false);
		expect(f.readRegistry()).toStrictEqual([]);
	}
});

test('CLI automatically resumes an existing worktree even when it is not registered', async () => {
	const f = fixture();
	f.worktreeOnly('STE-20');
	for (const input of ['20', 'ste-20']) {
		const result = await f.run([input]);
		expect(result.code).toBe(0);
		expect(f.readRecord().args).toStrictEqual(['--resume', 'STE-20']);
		expect(f.readRegistry()).toStrictEqual(['STE-20']);
	}
});

test('CLI --no-resume overrides automatic resume for an existing worktree', async () => {
	const f = fixture();
	f.worktreeOnly('STE-20');
	const result = await f.run(['STE-20', '--no-resume']);
	expect(result.code).toBe(0);
	expect(f.readRecord().args).toStrictEqual(['STE-20']);
	expect(f.readRegistry()).toStrictEqual(['STE-20']);
});

test('CLI initializes a saved space again if its worktree is gone', async () => {
	const f = fixture();
	await f.seed();
	const result = await f.run(['STE-1']);
	expect(result.code).toBe(0);
	expect(f.readRecord().args).toStrictEqual(['STE-1']);
	expect(f.readRegistry()).toStrictEqual(['STE-1']);
});

test('CLI saves the generated key from split, colored output for description and URL inputs', async () => {
	const f = fixture();
	for (const input of [
		'fix auth bug',
		'https://linear.app/team/issue/STE-99/fix-auth',
	]) {
		const result = await f.run(['--resume', input], {
			IDOW_TEST_OUTPUT: '\u001b[32mWorkspace STE-99 is ready!\u001b[0m\n',
		});
		expect(result.code).toBe(0);
		expect(f.readRegistry()).toStrictEqual(['STE-99']);
		expect(f.readRecord().args).toStrictEqual(['--resume', input]);
	}
});

test('CLI preserves lowercase beads keys and child issue suffixes', async () => {
	const f = fixture('beads');
	const result = await f.run(['STE-a1b2.1']);
	expect(result.code).toBe(0);
	expect(f.readRegistry()).toStrictEqual(['ste-a1b2.1']);
	expect(f.readRecord().args).toStrictEqual(['ste-a1b2.1']);
});

test('CLI registers the final summary key when the description quotes another ready message', async () => {
	const f = fixture();
	const input = 'fix the misleading Workspace STE-1 is ready! message';
	const result = await f.run([input], {
		IDOW_TEST_OUTPUT:
			`[2026-10-12 15:00:00] [startup] Input: ${input}\n` +
			'\u001b[0;32mWorkspace STE-99 is ready!\u001b[0m\n',
	});
	expect(result.code).toBe(0);
	expect(f.readRegistry()).toStrictEqual(['STE-99']);
});

test('CLI handles a broken stdout pipe and stops idow before returning failure', async () => {
	const f = fixture();
	await f.seed();
	const pidFile = path.join(f.root, 'idow.pid');
	const child = f.start(['STE-20'], {
		IDOW_TEST_PID_FILE: pidFile,
		IDOW_TEST_KEEP_ALIVE: '1',
	});
	child.stdin.end();
	const closed = once(child, 'close');
	let stderr = '';
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});
	child.stdout.once('data', () => child.stdout.destroy());
	const [code] = await once(child, 'exit');
	const pid = Number(fs.readFileSync(pidFile, 'utf8'));
	const idowAlive = isAlive(pid);
	if (idowAlive) process.kill(pid, 'SIGKILL');
	await closed;
	expect(code).toBe(1);
	expect(idowAlive).toBe(false);
	expect(stderr).toMatch(/Failed to run idow:.*EPIPE/);
	expect(stderr.includes('Unhandled')).toBe(false);
	expect(f.readRegistry()).toStrictEqual(['STE-1']);
});

test('CLI cancels idow subprocesses on a broken pipe even after the shell exits', async () => {
	for (const background of [false, true]) {
		const f = fixture();
		await f.seed();
		const pidFile = path.join(f.root, 'worker.pid');
		const sideEffect = path.join(f.root, 'worker.finished');
		const worker = path.join(f.root, 'worker.mjs');
		fs.writeFileSync(
			worker,
			`import fs from 'node:fs';
fs.writeFileSync(process.env.IDOW_TEST_PID_FILE, String(process.pid));
process.stdout.write('worker started\\n');
// The CLI only learns its stdout broke on its next write, so keep writing.
setInterval(() => process.stdout.write('worker progress\\n'), 50);
setTimeout(() => fs.writeFileSync(process.env.IDOW_TEST_SIDE_EFFECT, 'finished'), 500);
`,
		);
		fs.writeFileSync(
			f.idow,
			'#!/bin/bash\n"$IDOW_TEST_NODE" "$IDOW_TEST_WORKER"' +
				(background ? ' &\nexit 0\n' : '\n:\n'),
		);
		teardown(() => {
			if (!fs.existsSync(pidFile)) return;
			try {
				process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
			} catch {}
		});
		const child = f.start(['STE-20'], {
			IDOW_TEST_NODE: process.execPath,
			IDOW_TEST_WORKER: worker,
			IDOW_TEST_PID_FILE: pidFile,
			IDOW_TEST_SIDE_EFFECT: sideEffect,
		});
		child.stdin.end();
		const completion = once(child, 'close');
		let stderr = '';
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
		});
		let stdout = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
			if (stdout.includes('worker started')) child.stdout.destroy();
		});
		const [code] = await once(child, 'exit');
		await delay(600);
		const workerFinished = fs.existsSync(sideEffect);
		try {
			process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
		} catch {}
		await completion;
		expect(code).toBe(1);
		expect(workerFinished).toBe(false);
		expect(stderr).toMatch(/Failed to run idow:.*EPIPE/);
		expect(f.readRegistry()).toStrictEqual(['STE-1']);
	}
}, 30_000);

test('CLI forwards termination signals to idow subprocesses and preserves its signal exit', async () => {
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		const f = fixture();
		await f.seed();
		const pidFile = path.join(f.root, 'worker.pid');
		const sideEffect = path.join(f.root, 'worker.finished');
		const worker = path.join(f.root, 'worker.mjs');
		fs.writeFileSync(
			worker,
			`import fs from 'node:fs';
fs.writeFileSync(process.env.IDOW_TEST_PID_FILE, String(process.pid));
process.stdout.write('worker started\\n');
setTimeout(() => fs.writeFileSync(process.env.IDOW_TEST_SIDE_EFFECT, 'finished'), 500);
setTimeout(() => {}, 30000);
`,
		);
		fs.writeFileSync(
			f.idow,
			'#!/bin/bash\n"$IDOW_TEST_NODE" "$IDOW_TEST_WORKER"\n:\n',
		);
		const child = f.start(['STE-20'], {
			IDOW_TEST_NODE: process.execPath,
			IDOW_TEST_WORKER: worker,
			IDOW_TEST_PID_FILE: pidFile,
			IDOW_TEST_SIDE_EFFECT: sideEffect,
		});
		child.stdin.end();
		child.stderr.resume();
		const completion = once(child, 'close');
		let stdout = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
			if (stdout.includes('worker started')) child.kill(signal);
		});
		const exit = await once(child, 'exit');
		await delay(600);
		const workerFinished = fs.existsSync(sideEffect);
		try {
			process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
		} catch {}
		await completion;
		expect(exit).toStrictEqual([null, signal]);
		expect(workerFinished).toBe(false);
		expect(f.readRegistry()).toStrictEqual(['STE-1']);
	}
}, 30_000);

test('CLI preserves idow failure status without saving a space even after a ready message', async () => {
	const f = fixture();
	await f.seed();
	const result = await f.run(['STE-20'], {IDOW_TEST_STATUS: '7'});
	expect(result.code).toBe(7);
	expect(f.readRegistry()).toStrictEqual(['STE-1']);
});

test('CLI reports spawn failure instead of succeeding or saving a space', async () => {
	const f = fixture();
	await f.seed();
	fs.rmSync(f.idow);
	const result = await f.run(['STE-20']);
	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(/ENOENT/);
	expect(f.readRegistry()).toStrictEqual(['STE-1']);
});

test('CLI treats idow signal termination as failure without registering', async () => {
	const f = fixture();
	await f.seed();
	const result = await f.run(['STE-20'], {IDOW_TEST_SIGNAL: '1'});
	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(/SIGTERM/);
	expect(f.readRegistry()).toStrictEqual(['STE-1']);
});

test('CLI explains successful setup with an unresolved space key and fails', async () => {
	const f = fixture();
	const result = await f.run(['fix auth bug'], {
		IDOW_TEST_OUTPUT: 'Setup complete\n',
	});
	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(/setup completed.*register.*issue key/i);
	expect(f.readRegistry()).toStrictEqual([]);
});

test('CLI explains registration failure and leaves the registry as it was', async () => {
	const f = fixture();
	await f.seed();
	const release = f.holdWriteLock();
	let result;
	try {
		result = await f.run(['STE-20']);
	} finally {
		release();
	}

	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(/setup completed.*register/i);
	expect(f.readRegistry()).toStrictEqual(['STE-1']);
});

test('CLI streams output while setup is running and waits for registry persistence', async () => {
	const f = fixture();
	await f.seed();
	const release = f.holdWriteLock();
	teardown(release);
	const child = f.start(['STE-20']);
	child.stdin.end();
	child.stderr.resume();
	let output = '';
	let exited = false;
	const completion = once(child, 'close').then(([code]) => {
		exited = true;
		return code;
	});
	const outputReady = new Promise<void>(resolve => {
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			output += chunk;
			if (output.includes('Workspace STE')) resolve();
		});
	});
	await Promise.race([
		outputReady,
		completion.then(() => {
			throw new Error(`CLI exited before streaming idow output: ${output}`);
		}),
	]);
	expect(exited).toBe(false);
	await delay(100);
	expect(exited).toBe(false);
	release();
	expect(await completion).toBe(0);
	expect(f.readRegistry()).toStrictEqual(['STE-1', 'STE-20']);
});

test('CLI drains substantial forwarded stdout before exiting to a slow reader', async () => {
	const f = fixture();
	const bytes = 2 * 1024 * 1024;
	const child = f.start(['STE-20'], {IDOW_TEST_BYTES: String(bytes)});
	child.stdin.end();
	child.stderr.resume();
	const completion = once(child, 'close');
	let stdout = '';
	for await (const chunk of child.stdout) {
		stdout += String(chunk);
		await delay(2);
	}
	expect(await completion).toStrictEqual([0, null]);
	expect(stdout).toBe(
		'Starting new session with: "STE-20"\n' +
			'x'.repeat(bytes) +
			'Workspace STE-20 is ready!\n',
	);
	expect(f.readRegistry()).toStrictEqual(['STE-20']);
});

test('CLI --resume without input fails with usage before running idow or the TUI', async () => {
	const f = fixture();
	const result = await f.run(['--resume', '--no-layout']);
	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(/Usage: pappardelle --resume/);
	expect(fs.existsSync(f.record)).toBe(false);
	expect(f.readRegistry()).toStrictEqual([]);
});

test('CLI help documents --resume', async () => {
	const f = fixture();
	const result = await f.run(['--help']);
	expect(result.code).toBe(0);
	expect(result.stdout.includes('--resume')).toBe(true);
	expect(fs.existsSync(f.record)).toBe(false);
});

test('CLI highlight asks a running Pappardelle to select the space', async () => {
	const f = fixture();
	const {highlight} = f.stores();
	const selected: string[] = [];
	teardown(highlight.watch(request => selected.push(request.issueKey)));

	const result = await f.run(['highlight', 'STE-7']);
	expect(result.code).toBe(0);
	await until(() => selected.length > 0, {what: 'a highlight request'});
	expect(selected[0]).toBe('STE-7');
	expect(fs.existsSync(f.record)).toBe(false);
});

test('CLI commands still run with experimental.sqliteState in project or local config', async () => {
	const f = fixture();
	const localPath = path.join(f.repo, '.pappardelle.local.yml');
	fs.writeFileSync(localPath, 'experimental:\n  sqliteState: true\n');
	const localResult = await f.run(['highlight', 'STE-7']);
	expect(localResult.code, localResult.stderr).toBe(0);

	fs.unlinkSync(localPath);
	fs.appendFileSync(
		path.join(f.repo, '.pappardelle.yml'),
		'\nexperimental:\n  sqliteState: true\n',
	);
	const projectResult = await f.run(['highlight', 'STE-7']);
	expect(projectResult.code, projectResult.stderr).toBe(0);
});

test('CLI commands still run when an unrelated config section is invalid', async () => {
	const f = fixture();
	fs.writeFileSync(
		path.join(f.repo, '.pappardelle.local.yml'),
		'profiles:\n  broken:\n    agent_profile: nonexistent-agent\n',
	);
	const result = await f.run(['highlight', 'STE-7']);
	expect(result.code, result.stderr).toBe(0);
});
