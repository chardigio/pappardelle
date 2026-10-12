import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';

const projectRoot = path.resolve(import.meta.dirname, '..');
const useBuiltCli = process.env['PAPPARDELLE_TEST_BUILT_CLI'] === '1';

function fixture(t: ExecutionContext, provider = 'jira') {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-cli-space-')),
	);
	t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const repo = path.join(root, 'project');
	const home = path.join(root, 'home');
	const install = path.join(root, 'install');
	fs.mkdirSync(repo);
	fs.mkdirSync(home);
	fs.mkdirSync(path.join(install, 'scripts'), {recursive: true});
	const directory = useBuiltCli ? 'dist' : 'source';
	fs.cpSync(path.join(projectRoot, directory), path.join(install, directory), {
		recursive: true,
		filter: file => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
	});
	fs.symlinkSync(
		path.join(projectRoot, 'node_modules'),
		path.join(install, 'node_modules'),
	);
	fs.writeFileSync(path.join(install, 'package.json'), '{"type":"module"}');
	execFileSync('git', ['init', '--quiet', repo]);
	fs.writeFileSync(
		path.join(repo, '.pappardelle.yml'),
		`version: 1
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
	const registry = path.join(
		home,
		'.pappardelle',
		'repos',
		'project',
		'open-spaces.json',
	);
	const env = {
		...process.env,
		HOME: home,
		PAPPARDELLE_PROJECT_ROOT: repo,
		PAPPARDELLE_MAIN_REPO_ROOT: repo,
		IDOW_TEST_RECORD: record,
	};
	const start = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
		const child = spawn(
			process.execPath,
			[
				...(useBuiltCli ? [] : ['--import', import.meta.resolve('tsx')]),
				path.join(install, directory, useBuiltCli ? 'cli.js' : 'cli.tsx'),
				...args,
			],
			{
				cwd: repo,
				env: {...env, ...overrides},
				stdio: 'pipe',
			},
		);
		t.teardown(() => child.kill());
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
	const readRegistry = (): string[] =>
		JSON.parse(fs.readFileSync(registry, 'utf8')) as string[];
	const readRecord = () =>
		JSON.parse(fs.readFileSync(record, 'utf8')) as {
			args: string[];
			cwd: string;
			projectRoot: string;
			mainRepoRoot: string;
			stdin: string;
			stdinIsTTY: boolean;
		};
	const seed = () => {
		fs.mkdirSync(path.dirname(registry), {recursive: true});
		fs.writeFileSync(registry, '["STE-1"]\n');
	};
	return {
		root,
		repo,
		home,
		install,
		idow,
		record,
		registry,
		start,
		run,
		readRegistry,
		readRecord,
		seed,
	};
}

test('CLI saves a normalized issue from a non-TTY sous-chef invocation', async t => {
	const f = fixture(t);
	const result = await f.run(['20']);
	t.is(result.code, 0);
	t.deepEqual(f.readRegistry(), ['STE-20']);
	t.deepEqual(f.readRecord(), {
		args: ['STE-20'],
		cwd: f.repo,
		projectRoot: f.repo,
		mainRepoRoot: f.repo,
		stdin: '2\n',
		stdinIsTTY: false,
	});
	t.true(result.stdout.includes('Workspace STE-20 is ready!'));
	t.true(result.stderr.includes('idow diagnostic'));
	const spaces = JSON.parse(
		execFileSync(
			'bash',
			[
				path.join(
					projectRoot,
					'plugins/pappardelle/skills/sous-chef/scripts/gather-spaces.sh',
				),
				'project',
			],
			{env: {...process.env, HOME: f.home}, encoding: 'utf8'},
		),
	) as {spaces: Array<{name: string}>};
	t.deepEqual(
		spaces.spaces.map(space => space.name),
		['STE-20'],
	);
});

test('CLI resumes with the flag first and preserves existing spaces without duplicates', async t => {
	const f = fixture(t);
	f.seed();
	for (const argv of [
		['--resume', 'ste-20'],
		['STE-20', '--resume'],
	]) {
		const result = await f.run(argv);
		t.is(result.code, 0);
		t.deepEqual(f.readRecord().args, ['--resume', 'STE-20']);
		t.deepEqual(f.readRegistry(), ['STE-1', 'STE-20']);
	}
});

test('CLI saves the generated key from split, colored output for description and URL inputs', async t => {
	const f = fixture(t);
	for (const input of [
		'fix auth bug',
		'https://linear.app/team/issue/STE-99/fix-auth',
	]) {
		const result = await f.run(['--resume', input], {
			IDOW_TEST_OUTPUT: '\u001b[32mWorkspace STE-99 is ready!\u001b[0m\n',
		});
		t.is(result.code, 0);
		t.deepEqual(f.readRegistry(), ['STE-99']);
		t.deepEqual(f.readRecord().args, ['--resume', input]);
	}
});

test('CLI preserves lowercase beads keys and child issue suffixes', async t => {
	const f = fixture(t, 'beads');
	const result = await f.run(['STE-a1b2.1']);
	t.is(result.code, 0);
	t.deepEqual(f.readRegistry(), ['ste-a1b2.1']);
	t.deepEqual(f.readRecord().args, ['ste-a1b2.1']);
});

test('CLI preserves idow failure status without saving a space even after a ready message', async t => {
	const f = fixture(t);
	f.seed();
	const result = await f.run(['STE-20'], {IDOW_TEST_STATUS: '7'});
	t.is(result.code, 7);
	t.deepEqual(f.readRegistry(), ['STE-1']);
});

test('CLI reports spawn failure instead of succeeding or saving a space', async t => {
	const f = fixture(t);
	f.seed();
	fs.rmSync(f.idow);
	const result = await f.run(['STE-20']);
	t.is(result.code, 1);
	t.regex(result.stderr, /ENOENT/);
	t.deepEqual(f.readRegistry(), ['STE-1']);
});

test('CLI treats idow signal termination as failure without registering', async t => {
	const f = fixture(t);
	f.seed();
	const result = await f.run(['STE-20'], {IDOW_TEST_SIGNAL: '1'});
	t.is(result.code, 1);
	t.regex(result.stderr, /SIGTERM/);
	t.deepEqual(f.readRegistry(), ['STE-1']);
});

test('CLI explains successful setup with an unresolved space key and fails', async t => {
	const f = fixture(t);
	const result = await f.run(['fix auth bug'], {
		IDOW_TEST_OUTPUT: 'Setup complete\n',
	});
	t.is(result.code, 1);
	t.regex(result.stderr, /setup completed.*register.*issue key/i);
	t.false(fs.existsSync(f.registry));
});

test('CLI explains registration failure and leaves invalid registry state intact', async t => {
	const f = fixture(t);
	f.seed();
	fs.writeFileSync(f.registry, '{');
	const result = await f.run(['STE-20']);
	t.is(result.code, 1);
	t.regex(result.stderr, /setup completed.*register/i);
	t.is(fs.readFileSync(f.registry, 'utf8'), '{');
	t.false(fs.existsSync(`${f.registry}.lock`));
});

test('CLI streams output while setup is running and waits for registry persistence', async t => {
	const f = fixture(t);
	f.seed();
	const lock = `${f.registry}.lock`;
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, `${process.pid}-abcdef`), '');
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
	t.false(exited);
	await delay(100);
	t.false(exited);
	t.deepEqual(f.readRegistry(), ['STE-1']);
	fs.rmSync(lock, {recursive: true});
	t.is(await completion, 0);
	t.deepEqual(f.readRegistry(), ['STE-1', 'STE-20']);
});

test('CLI drains substantial forwarded stdout before exiting to a slow reader', async t => {
	const f = fixture(t);
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
	t.deepEqual(await completion, [0, null]);
	t.is(
		stdout,
		'Starting new session with: "STE-20"\n' +
			'x'.repeat(bytes) +
			'Workspace STE-20 is ready!\n',
	);
	t.deepEqual(f.readRegistry(), ['STE-20']);
});

test('CLI --resume without input fails with usage before running idow or the TUI', async t => {
	const f = fixture(t);
	const result = await f.run(['--resume', '--no-layout']);
	t.is(result.code, 1);
	t.regex(result.stderr, /Usage: pappardelle --resume/);
	t.false(fs.existsSync(f.record));
	t.false(fs.existsSync(f.registry));
});

test('CLI help documents --resume', async t => {
	const f = fixture(t);
	const result = await f.run(['--help']);
	t.is(result.code, 0);
	t.true(result.stdout.includes('--resume'));
	t.false(fs.existsSync(f.record));
});
