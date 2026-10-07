/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
import {
	type ExecFileException,
	execFile,
	execFileSync,
} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import YAML from 'js-yaml';

const scriptsDir = path.resolve(import.meta.dirname, '../scripts');

function writeScript(filename: string, body: string) {
	const script = `#!/bin/bash\nset -e\n${body}\n`;
	execFileSync('shellcheck', ['-s', 'bash', '-'], {input: script});
	fs.writeFileSync(filename, script, {mode: 0o755});
}

function setup(t: ExecutionContext) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'idow-config-')),
	);
	t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const main = path.join(root, 'main checkout');
	const linked = path.join(root, 'linked checkout');
	const scripts = path.join(root, 'scripts');
	const bin = path.join(root, 'bin');
	const home = path.join(root, 'home');
	const workspace = path.join(root, 'new workspace');
	const launchArgs = path.join(root, 'launch-args');
	const vcsCalls = path.join(root, 'vcs-calls');
	const launchers = path.join(root, 'launchers');
	for (const dir of [main, scripts, bin, home]) fs.mkdirSync(dir);
	const git = (...args: string[]) =>
		execFileSync('git', ['-C', main, ...args], {stdio: 'pipe'});
	git('init');
	git(
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.com',
		'commit',
		'--allow-empty',
		'-m',
		'initial',
	);
	git('worktree', 'add', '-b', 'linked', linked);
	for (const file of [
		'idow',
		'provider-helpers.sh',
		'resolve-agent-config.sh',
		'resolve-terminal-app.sh',
	]) {
		fs.copyFileSync(path.join(scriptsDir, file), path.join(scripts, file));
	}
	// Step 9 is stubbed rather than copied: the real launchers drive iTerm,
	// Ghostty or `open`, so an unstubbed --open run would pop a terminal window
	// on the machine running the suite, and which one it picked would depend on
	// the host's terminal rather than the fixture.
	for (const [launcher, name] of [
		['open-ghostty-agent.sh', 'ghostty'],
		['open-iterm-agent.sh', 'iterm'],
		['open-default-terminal-agent.sh', 'default'],
	] as const) {
		writeScript(
			path.join(scripts, launcher),
			`printf '%s %s\\n' ${name} "$*" >> "$IDOW_TEST_LAUNCHERS"\nexit "\${IDOW_TEST_EXIT_${name.toUpperCase()}:-0}"`,
		);
	}
	// idow asks Ghostty for its front window before the slow steps; a real
	// osascript would send that Apple Event to whatever Ghostty the host runs.
	writeScript(path.join(bin, 'osascript'), 'printf "%s\\n" tab-group-test');
	writeScript(
		path.join(bin, 'bd'),
		`printf '%s\\n' '{"id":"test-abc","title":"Test issue","description":""}'`,
	);
	writeScript(
		path.join(bin, 'gh'),
		'printf "%s\\n" "$*" >> "$IDOW_TEST_VCS_CALLS"\nprintf "%s\\n" "https://github.com/test/repo/pull/1"',
	);
	writeScript(path.join(bin, 'tmux'), 'exit 1');
	writeScript(
		path.join(scripts, 'start-agent-session.sh'),
		`printf '%s\\n' "$@" > "$IDOW_TEST_LAUNCH_ARGS"`,
	);
	writeScript(
		path.join(scripts, 'create-worktree.sh'),
		`mkdir -p "$IDOW_TEST_WORKSPACE"
jq -n --arg worktree_path "$IDOW_TEST_WORKSPACE" '{worktree_path: $worktree_path}'`,
	);
	fs.writeFileSync(path.join(main, '.env'), 'FROM_MAIN=1\n');

	const config = (displayName: string) =>
		YAML.dump({
			version: 1,
			team_prefix: 'test',
			issue_tracker: {provider: 'beads'},
			default_profile: 'dev',
			terminal: {app: 'none'},
			profiles: {
				dev: {
					display_name: displayName,
					post_workspace_init: [
						{
							name: 'Profile init',
							run: 'cp "${MAIN_REPO_ROOT}/.env" "${WORKTREE_PATH}/profile.env"',
						},
					],
				},
			},
			post_workspace_init: [
				{
					name: 'Global init',
					run: 'cp "${MAIN_REPO_ROOT}/.env" "${WORKTREE_PATH}/.env"',
				},
			],
			hooks: {
				post_workspace_create: [
					{
						name: 'Create hook',
						run: 'printf "%s\\n" "${MAIN_REPO_ROOT}" "${REPO_ROOT}" > "${WORKTREE_PATH}/roots"',
					},
				],
			},
		});
	fs.writeFileSync(path.join(main, '.pappardelle.yml'), config('Main config'));
	fs.writeFileSync(
		path.join(main, '.pappardelle.local.yml'),
		'claude:\n  model: main-model\n',
	);

	return {
		main,
		linked,
		workspace,
		launchArgs,
		vcsCalls,
		launchers,
		home,
		config,
		async run({
			open = false,
			projectRoot = true,
			onExit = () => {},
			extraEnv = {},
			profile,
		}: {
			open?: boolean;
			projectRoot?: boolean;
			onExit?: () => void;
			extraEnv?: Record<string, string>;
			profile?: string;
		} = {}): Promise<string> {
			const env = {...process.env};
			delete env.PAPPARDELLE_PROJECT_ROOT;
			delete env.MAIN_REPO_ROOT;
			// idow exports this into every workspace it spawns, so a suite run
			// from inside a Pappardelle session inherits it and the fixture
			// resolves the real checkout instead of its own.
			delete env.PAPPARDELLE_MAIN_REPO_ROOT;
			return new Promise((resolve, reject) => {
				const child = execFile(
					'bash',
					[
						path.join(scripts, 'idow'),
						...(open ? ['--resume', '--open'] : []),
						...(profile ? ['--profile', profile] : []),
						'--issue-key',
						'test-abc',
					],
					{
						cwd: projectRoot ? root : linked,
						encoding: 'utf8',
						timeout: 30_000,
						env: {
							...env,
							HOME: home,
							PATH: `${bin}:${process.env.PATH!}`,
							...(projectRoot ? {PAPPARDELLE_PROJECT_ROOT: linked} : {}),
							IDOW_TEST_WORKSPACE: workspace,
							IDOW_TEST_LAUNCH_ARGS: launchArgs,
							IDOW_TEST_VCS_CALLS: vcsCalls,
							IDOW_TEST_LAUNCHERS: launchers,
							...extraEnv,
						},
					},
					(error, stdout) => {
						if (error instanceof Error) reject(error);
						else resolve(stdout);
					},
				);
				child.once('exit', onExit);
			});
		},
	};
}

test('idow creates a session using main config and worktree-local overrides', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.local.yml'),
		'claude:\n  model: linked-model\n',
	);
	const output = await fixture.run();
	t.false(fs.existsSync(fixture.vcsCalls));
	t.true(output.includes('Workspace test-abc is ready!'), output);
	t.true(output.includes('Profile:   Main config'), output);
	t.true(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model linked-model\n'),
	);
	t.is(
		fs.readFileSync(
			path.join(fixture.workspace, '.pappardelle.local.yml'),
			'utf8',
		),
		'claude:\n  model: linked-model\n',
	);
	for (const file of ['.env', 'profile.env']) {
		t.is(
			fs.readFileSync(path.join(fixture.workspace, file), 'utf8'),
			'FROM_MAIN=1\n',
		);
	}
});

test('idow opens from a linked checkout and expands both repository roots', async t => {
	const fixture = setup(t);
	const output = await fixture.run({open: true, projectRoot: false});
	t.true(fs.readFileSync(fixture.vcsCalls, 'utf8').includes('pr view'));
	t.true(output.includes('https://github.com/test/repo/pull/1'));
	t.true(output.includes('Workspace test-abc is ready!'), output);
	t.true(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model main-model\n'),
	);
	t.is(
		fs.readFileSync(path.join(fixture.workspace, 'roots'), 'utf8'),
		`${fixture.main}\n${fixture.linked}\n`,
	);
});

test('idow prefers a worktree project config while falling back for local config', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.yml'),
		fixture.config('Linked config'),
	);
	const output = await fixture.run();
	t.true(output.includes('Profile:   Linked config'), output);
	t.true(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model main-model\n'),
	);
});

test('background initialization releases setup pipes before the hook finishes', async t => {
	const fixture = setup(t);
	const hook = path.join(fixture.main, 'background.sh');
	writeScript(
		hook,
		`
touch "$IDOW_TEST_WORKSPACE/background-started"
while [[ ! -f "$IDOW_TEST_WORKSPACE/release" ]]; do sleep 0.05; done
printf 'background stdout\\n'
printf 'background stderr\\n' >&2
touch "$IDOW_TEST_WORKSPACE/background-finished"`,
	);
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			post_workspace_init: [
				{
					name: 'Background hook',
					run: 'bash "${MAIN_REPO_ROOT}/background.sh"',
					background: true,
				},
			],
		}),
	);
	let exited = () => {};
	const exit = new Promise<void>(resolve => {
		exited = resolve;
	});
	const result = fixture.run({onExit: exited});
	try {
		await Promise.race([exit, result]);
		for (
			let i = 0;
			i < 100 &&
			!fs.existsSync(path.join(fixture.workspace, 'background-started'));
			i++
		)
			await delay(10);
		t.true(fs.existsSync(path.join(fixture.workspace, 'background-started')));
		t.false(fs.existsSync(path.join(fixture.workspace, 'background-finished')));
		const closed = await Promise.race([
			result.then(() => true),
			delay(1000).then(() => false),
		]);
		t.true(
			closed,
			'Background hook must not hold the setup stdout/stderr pipes open',
		);
	} finally {
		fs.writeFileSync(path.join(fixture.workspace, 'release'), '');
		await result;
		for (
			let i = 0;
			i < 100 &&
			!fs.existsSync(path.join(fixture.workspace, 'background-finished'));
			i++
		)
			await delay(10);
	}
	t.true(fs.existsSync(path.join(fixture.workspace, 'background-finished')));
	const logDir = path.join(fixture.home, 'Library/Logs/stardust-workspace');
	const files = fs
		.readdirSync(logDir)
		.filter(name => name.startsWith('idow-test-abc-'));
	t.is(files.length, 1);
	const log = fs.readFileSync(path.join(logDir, files[0]!), 'utf8');
	t.true(log.includes('[test-abc]'));
	t.true(log.includes('background stdout'));
	t.true(log.includes('background stderr'));
});

test('idow rotates per invocation and prunes only old invocation logs', async t => {
	const fixture = setup(t);
	const dir = path.join(fixture.home, 'Library/Logs/stardust-workspace');
	fs.mkdirSync(dir, {recursive: true});
	const stale = path.join(dir, 'idow-old-workspace-20200101-test.log');
	const unrelated = path.join(dir, 'unrelated.log');
	for (const file of [stale, unrelated]) {
		fs.writeFileSync(file, 'old');
		fs.utimesSync(file, new Date(0), new Date(0));
	}
	await fixture.run();
	await fixture.run();
	const files = fs.readdirSync(dir);
	t.false(files.includes(path.basename(stale)));
	t.true(files.includes('unrelated.log'));
	t.is(files.filter(name => name.startsWith('idow-test-abc-')).length, 2);
});

// Step 9 tries Ghostty, then iTerm, then the default terminal, and stops at the
// first that opens. Only a run where every launcher fails may exit non-zero:
// the TUI keys its "Opened" / "Open failed" header off that exit code.
const fallbackCases = [
	{
		title: 'Ghostty opens and nothing else runs',
		app: 'Ghostty',
		failing: [],
		ran: ['ghostty'],
	},
	{
		title: 'a failed Ghostty falls back to iTerm',
		app: 'Ghostty',
		failing: ['GHOSTTY'],
		ran: ['ghostty', 'iterm'],
	},
	{
		title: 'a failed iTerm falls back to the default terminal',
		app: 'Ghostty',
		failing: ['GHOSTTY', 'ITERM'],
		ran: ['ghostty', 'iterm', 'default'],
	},
	{
		title: 'every launcher failing reports failure',
		app: 'Ghostty',
		failing: ['GHOSTTY', 'ITERM', 'DEFAULT'],
		ran: ['ghostty', 'iterm', 'default'],
	},
	{
		title:
			'a terminal Pappardelle does not drive opens in the default terminal',
		app: 'Alacritty',
		failing: [],
		ran: ['default'],
	},
];

for (const c of fallbackCases) {
	test(`step 9: ${c.title}`, async t => {
		const fixture = setup(t);
		fs.writeFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			`claude:\n  model: main-model\nterminal:\n  app: ${c.app}\n`,
		);
		const run = fixture.run({
			open: true,
			extraEnv: Object.fromEntries(
				c.failing.map(name => [`IDOW_TEST_EXIT_${name}`, '1']),
			),
		});
		if (c.failing.length === 3) {
			const error = await t.throwsAsync(run);
			t.is((error as ExecFileException | undefined)?.code, 1);
		} else {
			await run;
		}

		const ran = fs
			.readFileSync(fixture.launchers, 'utf8')
			.trim()
			.split('\n')
			.map(line => line.split(' ')[0]);
		t.deepEqual(ran, c.ran);
	});
}

// The window is captured before worktree creation and profile commands, which
// can run for minutes, so the tab lands where the user pressed `o` rather than
// wherever focus has moved since.
test('step 9 hands Ghostty the window captured at startup', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		'claude:\n  model: main-model\nterminal:\n  app: Ghostty\n',
	);
	await fixture.run({open: true});
	t.regex(
		fs.readFileSync(fixture.launchers, 'utf8'),
		/^ghostty .*--window-id tab-group-test/m,
	);
});

test('an explicit profile pick on an existing space is persisted and reused', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			agent_profiles: {codex: {command: 'codex', resume_args: 'resume --last'}},
			profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
		}),
	);
	const statePath = path.join(
		fixture.home,
		'.pappardelle/repos/linked checkout/space-state/test-abc.json',
	);
	const persisted = () =>
		(JSON.parse(fs.readFileSync(statePath, 'utf8')) as {profile: string})
			.profile;
	const agentCommand = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-command') + 1];
	};

	await fixture.run();
	t.is(persisted(), 'dev');
	// create-worktree.sh is stubbed to build the workspace elsewhere, so idow
	// only sees an existing worktree once its own path exists.
	fs.mkdirSync(path.join(fixture.home, '.worktrees/linked checkout/test-abc'), {
		recursive: true,
	});

	// Reopening with a different pick: the worktree already exists.
	await fixture.run({profile: 'other'});
	t.is(persisted(), 'other');
	t.is(agentCommand(), 'codex');

	// An unforced run (the TUI's `o`) keeps the picked profile instead of
	// falling back to default_profile.
	const output = await fixture.run({open: true});
	t.is(persisted(), 'other');
	t.is(agentCommand(), 'codex');
	t.true(output.includes('Profile:   Other'), output);
});

// codex's `resume --last` is not scoped to the cwd, so resuming in a brand new
// worktree would reopen another workspace's conversation.
test('a new worktree launches the agent without its resume args', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			agent_profiles: {codex: {command: 'codex', resume_args: 'resume --last'}},
			profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
		}),
	);
	const resumeArgs = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-resume-args') + 1];
	};

	await fixture.run({profile: 'other'});
	t.is(resumeArgs(), '');
	// create-worktree.sh is stubbed to build the workspace elsewhere, so idow
	// only sees an existing worktree once its own path exists.
	fs.mkdirSync(path.join(fixture.home, '.worktrees/linked checkout/test-abc'), {
		recursive: true,
	});

	await fixture.run({open: true});
	t.is(resumeArgs(), 'resume --last');
	t.regex(
		fs.readFileSync(fixture.launchers, 'utf8'),
		/--agent-resume-args resume --last --agent-is-claude false/,
	);
});

test('a reopened space resumes the session its agent recorded', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			agent_profiles: {
				codex: {command: 'codex', resume_args: 'resume {session_id}'},
			},
			profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
		}),
	);
	const statePath = path.join(
		fixture.home,
		'.pappardelle/repos/linked checkout/space-state/test-abc.json',
	);
	const record = (agentProfile: string) => {
		fs.mkdirSync(path.dirname(statePath), {recursive: true});
		fs.writeFileSync(
			statePath,
			JSON.stringify({
				profile: 'other',
				agentSession: {agentProfile, id: 'thread-1'},
			}),
		);
	};
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	// A new worktree drops a session left by an earlier space with the same key.
	record('codex');
	await fixture.run({profile: 'other'});
	t.is(launchArg('--agent-resume-args'), '');
	t.false('agentSession' in JSON.parse(fs.readFileSync(statePath, 'utf8')));

	fs.mkdirSync(path.join(fixture.home, '.worktrees/linked checkout/test-abc'), {
		recursive: true,
	});
	record('codex');
	await fixture.run({open: true});
	t.is(launchArg('--agent-resume-args'), 'resume thread-1');
	t.is(launchArg('--agent-profile'), 'codex');

	// An id recorded by another agent profile is not this one's conversation.
	record('claude');
	await fixture.run({open: true});
	t.is(launchArg('--agent-resume-args'), '');
});

test('a reopened claude space with no recorded session continues its conversation', async t => {
	const fixture = setup(t);
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	await fixture.run({});
	t.is(launchArg('--agent-resume-args'), '');

	fs.mkdirSync(path.join(fixture.home, '.worktrees/linked checkout/test-abc'), {
		recursive: true,
	});
	await fixture.run({open: true});
	t.is(launchArg('--agent-resume-args'), '--continue');
});
