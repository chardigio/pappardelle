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
import {idowSkippedAgentOverride} from './session-routing.ts';

const scriptsDir = path.resolve(import.meta.dirname, '../scripts');

function writeScript(filename: string, body: string) {
	const script = `#!/bin/bash\nset -e\n${body}\n`;
	execFileSync('shellcheck', ['-s', 'bash', '-'], {input: script});
	fs.writeFileSync(filename, script, {mode: 0o755});
}

function setup(t: ExecutionContext, realWorktree = false) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'idow-config-')),
	);
	t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const main = path.join(root, 'main checkout');
	const linked = path.join(root, 'linked checkout');
	const scripts = path.join(root, 'scripts');
	const bin = path.join(root, 'bin');
	const home = path.join(root, 'home');
	const workspace = realWorktree
		? path.join(home, '.worktrees', path.basename(main), 'test-abc')
		: path.join(root, 'new workspace');
	const launchArgs = path.join(root, 'launch-args');
	const vcsCalls = path.join(root, 'vcs-calls');
	const configCalls = path.join(root, 'config-calls');
	const openCalls = path.join(root, 'open-calls');
	const yq = execFileSync('which', ['yq'], {encoding: 'utf8'}).trim();
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
		'derive-title.sh',
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
		'test -f "$IDOW_TEST_LAUNCH_ARGS"\nprintf "%s\\n" "$*" >> "$IDOW_TEST_VCS_CALLS"\nprintf "%s\\n" "https://github.com/test/repo/pull/1"',
	);
	writeScript(path.join(bin, 'tmux'), 'exit 1');
	writeScript(
		path.join(bin, 'open'),
		'printf "%s\\n" "$@" >> "$IDOW_TEST_OPEN_CALLS"',
	);
	writeScript(
		path.join(bin, 'yq'),
		`printf "%s\\n" "$1" >> "$IDOW_TEST_CONFIG_CALLS"
if [[ "\${IDOW_TEST_FAIL_PR_INSPECTION:-}" == true && "$2" == *'hooks.post_workspace_create]'* ]]; then
    printf 'partial inspection output\\n'
    exit 1
fi
exec "$IDOW_TEST_YQ" "$@"`,
	);
	writeScript(
		path.join(scripts, 'start-agent-session.sh'),
		`printf '%s\\n' "$@" > "$IDOW_TEST_LAUNCH_ARGS"`,
	);
	writeScript(
		path.join(scripts, 'create-worktree.sh'),
		`mkdir -p "$IDOW_TEST_WORKSPACE"
jq -n --arg worktree_path "$IDOW_TEST_WORKSPACE" '{worktree_path: $worktree_path}'`,
	);
	if (realWorktree) {
		fs.copyFileSync(
			path.join(scriptsDir, 'create-worktree.sh'),
			path.join(scripts, 'create-worktree.sh'),
		);
		const origin = path.join(root, 'origin.git');
		git('init', '--bare', origin);
		git('remote', 'add', 'origin', origin);
		const branch = git('branch', '--show-current').toString().trim();
		git('push', '-u', 'origin', branch);
		git(
			'symbolic-ref',
			'refs/remotes/origin/HEAD',
			`refs/remotes/origin/${branch}`,
		);
	}
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
					links: [{url: '${PR_URL}', if_set: 'PR_URL'}],
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
		configCalls,
		openCalls,
		launchers,
		home,
		bin,
		config,
		async run({
			open = false,
			projectRoot = true,
			onExit = () => {},
			extraEnv = {},
			profile,
			agentProfile,
			input,
		}: {
			open?: boolean;
			projectRoot?: boolean;
			onExit?: () => void;
			extraEnv?: Record<string, string>;
			profile?: string;
			agentProfile?: string;
			input?: string;
		} = {}): Promise<string> {
			const env = {...process.env};
			delete env.PAPPARDELLE_PROJECT_ROOT;
			delete env.MAIN_REPO;
			delete env.WORKTREES_ROOT;
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
						...(agentProfile ? ['--agent-profile', agentProfile] : []),
						...(input
							? ['--profile', 'dev', input]
							: ['--issue-key', 'test-abc']),
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
							IDOW_TEST_CONFIG_CALLS: configCalls,
							IDOW_TEST_OPEN_CALLS: openCalls,
							IDOW_TEST_YQ: yq,
							IDOW_TEST_LAUNCHERS: launchers,
							...extraEnv,
						},
					},
					(error, stdout) => {
						if (error instanceof Error) reject(error);
						else resolve(stdout);
					},
				);
				child.stdin?.end();
				child.once('exit', onExit);
			});
		},
	};
}

test('idow creates and reopens real worktrees in the main repository namespace', async t => {
	const fixture = setup(t, true);
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.local.yml'),
		'claude:\n  model: linked-model\n',
	);
	const output = await fixture.run();
	t.true(output.includes(`Worktree:  ${fixture.workspace}`), output);
	t.true(fs.existsSync(path.join(fixture.workspace, '.git')));
	const args = fs.readFileSync(fixture.launchArgs, 'utf8');
	t.true(args.includes(`--repo-name\n${path.basename(fixture.main)}\n`));
	t.true(args.includes('--agent-launch-flags\n--model linked-model\n'));
	t.true(
		fs.existsSync(
			path.join(
				fixture.home,
				'.pappardelle',
				'repos',
				path.basename(fixture.main),
				'space-state',
				'test-abc.json',
			),
		),
	);
	const reopened = await fixture.run();
	t.true(reopened.includes(`Worktree exists: ${fixture.workspace}`), reopened);
	t.false(reopened.includes('Created worktree:'));
});

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
		'.pappardelle/repos/main checkout/space-state/test-abc.json',
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
	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
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
test('a recreated worktree launches the agent without resume args not tied to it', async t => {
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
	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});

	await fixture.run({open: true});
	t.is(resumeArgs(), 'resume --last');
	t.regex(
		fs.readFileSync(fixture.launchers, 'utf8'),
		/--agent-resume-args resume --last --agent-is-claude false/,
	);
});

// Claude keys --continue by directory, and a recreated worktree reuses the
// same path, so the space's conversation is still there to continue.
test('a recreated worktree keeps claude resume args without a session id', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			agent_profiles: {
				claude: {command: 'claude', resume_args: '--continue --fork-session'},
			},
		}),
	);

	await fixture.run();
	const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
	t.is(
		args[args.indexOf('--agent-resume-args') + 1],
		'--continue --fork-session',
	);
});

// The TUI renders the rail emoji and picks the agent profile from space-state,
// and a slow post_workspace_init must not leave that window open.
test('the profile is persisted before post_workspace_init runs', async t => {
	const fixture = setup(t);
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			post_workspace_init: [
				{
					run: 'cp "$HOME/.pappardelle/repos/main checkout/space-state/test-abc.json" "$WORKTREE_PATH/state-during-init.json"',
				},
			],
		}),
	);

	await fixture.run();
	const seen = fs.readFileSync(
		path.join(fixture.workspace, 'state-during-init.json'),
		'utf8',
	);
	t.is((JSON.parse(seen) as {profile: string}).profile, 'dev');
});

test('--agent-profile launches another agent profile for that run only', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({agent_profiles: {codex: {command: 'codex'}}}),
	);
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	const stdout = await fixture.run({agentProfile: 'codex'});
	t.is(launchArg('--agent-profile'), 'codex');
	t.is(launchArg('--agent-command'), 'codex');
	t.false(idowSkippedAgentOverride(stdout));
	const statePath = path.join(
		fixture.home,
		'.pappardelle/repos/main checkout/space-state/test-abc.json',
	);
	t.false('agentProfile' in JSON.parse(fs.readFileSync(statePath, 'utf8')));

	await fixture.run();
	t.is(launchArg('--agent-profile'), 'claude');
});

test('--agent-profile on a space whose agent is running says it was not applied', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({agent_profiles: {codex: {command: 'codex'}}}),
	);
	writeScript(path.join(fixture.bin, 'tmux'), 'exit 0');

	const stdout = await fixture.run({agentProfile: 'codex'});
	t.regex(stdout, /Agent session already running/);
	t.true(idowSkippedAgentOverride(stdout));
});

// start-agent-session.sh renames a pre-upgrade claude-* session rather than
// starting the picked agent profile.
test('--agent-profile on a space still running under its legacy session name says it was not applied', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({agent_profiles: {codex: {command: 'codex'}}}),
	);
	writeScript(
		path.join(fixture.bin, 'tmux'),
		'[[ "$*" != *"has-session"* || "$*" == *"=claude-"* ]]',
	);

	t.true(idowSkippedAgentOverride(await fixture.run({agentProfile: 'codex'})));
});

test('an unknown --agent-profile stops idow before any setup', async t => {
	const fixture = setup(t);
	const error = await t.throwsAsync(fixture.run({agentProfile: 'codx'}));
	t.regex(String(error), /agent profile "codx" not found in agent_profiles/);
	t.false(fs.existsSync(fixture.workspace));
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
	const sessionsPath = path.join(
		fixture.home,
		'.pappardelle/repos/main checkout/space-state/test-abc.agent-sessions.json',
	);
	const record = (agentSessions: Record<string, string>) => {
		fs.mkdirSync(path.dirname(sessionsPath), {recursive: true});
		fs.writeFileSync(sessionsPath, JSON.stringify(agentSessions));
	};
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	// An existing issue resumes its conversation even in a recreated worktree.
	record({codex: 'thread-1'});
	await fixture.run({profile: 'other'});
	t.is(launchArg('--agent-resume-args'), 'resume thread-1');

	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});
	record({codex: 'thread-1'});
	await fixture.run({open: true});
	t.is(launchArg('--agent-resume-args'), 'resume thread-1');
	t.is(launchArg('--agent-profile'), 'codex');

	// An id recorded by another agent profile is not this one's conversation.
	record({claude: 'thread-2'});
	await fixture.run({open: true});
	t.is(launchArg('--agent-resume-args'), '');

	// An override launch resumes its own agent profile's conversation, and the
	// profile's agent still finds its own afterwards.
	record({codex: 'thread-1', claude: 'thread-2'});
	await fixture.run({open: true, agentProfile: 'claude'});
	t.is(launchArg('--agent-resume-args'), '--resume thread-2');
	await fixture.run({open: true});
	t.is(launchArg('--agent-resume-args'), 'resume thread-1');
});

test('a reopened claude space with no recorded session continues its conversation', async t => {
	const fixture = setup(t);
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	// An existing issue continues even in a recreated worktree; only a new
	// issue launches fresh.
	await fixture.run({});
	t.is(launchArg('--agent-resume-args'), '--continue');

	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});
	await fixture.run({open: true});
	t.is(launchArg('--agent-resume-args'), '--continue');
});

test('a claude space with no recorded session keeps its other resume flags', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			agent_profiles: {
				claude: {
					command: 'claude',
					resume_args: '--resume {session_id} --fork-session',
				},
			},
		}),
	);
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	await fixture.run();
	t.is(launchArg('--agent-resume-args'), '--continue --fork-session');
});

test('setup merges config once and does not resolve the terminal', async t => {
	const fixture = setup(t);
	await fixture.run();
	const calls = fs.readFileSync(fixture.configCalls, 'utf8').split('\n');
	t.is(calls.filter(call => call === 'eval-all').length, 1);
	t.false(calls.some(call => call.includes('.terminal.app')));
});

test('opening without PR consumers skips VCS lookup', async t => {
	const fixture = setup(t);
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({profiles: {dev: {links: []}}}),
	);
	const output = await fixture.run({open: true});
	t.false(fs.existsSync(fixture.vcsCalls));
	t.true(fs.existsSync(fixture.launchArgs));
	t.false(output.includes('PR:'));
	t.true(output.includes('Skipping PR/MR lookup'), output);
});

test('newly created issues launch fresh; existing keys keep conversation resume', async t => {
	const fixture = setup(t);
	const resumeArgs = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-resume-args') + 1];
	};
	await fixture.run({input: 'Make workspace startup faster'});
	t.is(resumeArgs(), '');
	await fixture.run();
	t.is(resumeArgs(), '--continue');
});

test('a bad claude config fails before the issue is created', async t => {
	const fixture = setup(t);
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({claude: {extra_args: '--verbose'}}),
	);
	await t.throwsAsync(fixture.run({input: 'Make workspace startup faster'}));
	t.false(
		fs.existsSync(
			path.join(fixture.home, '.pappardelle', 'repos', 'main checkout'),
		),
	);
});

test('batched commands preserve order, multiline strings and command stdin', async t => {
	const fixture = setup(t);
	const expected = 'a\tb\nquoted "text" and \u0024(literal)\n';
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			post_workspace_init: [
				// Reading stdin must not consume the next command's config record.
				{name: 'Read stdin\n\n', run: 'cat > "${WORKTREE_PATH}/stdin"'},
				{run: `printf '%s' '${expected}' > "\${WORKTREE_PATH}/value"`},
				{run: 'false', continue_on_error: true},
				{run: 'printf done >> "${WORKTREE_PATH}/value"'},
			],
		}),
	);
	const output = await fixture.run();
	t.true(output.includes('Read stdin\n'), output);
	t.false(output.includes('Read stdin\n\n'), output);
	t.true(
		output.includes('post_workspace_init: post_workspace_init[1] ->'),
		output,
	);
	t.is(fs.readFileSync(path.join(fixture.workspace, 'stdin'), 'utf8'), '');
	t.is(
		fs.readFileSync(path.join(fixture.workspace, 'value'), 'utf8'),
		expected + 'done',
	);
});

test('an aliased post_workspace_init list still runs', async t => {
	const fixture = setup(t);
	const config = YAML.load(fixture.config('Main config')) as Record<
		string,
		unknown
	>;
	delete config['post_workspace_init'];
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.yml'),
		YAML.dump(config) +
			'common: &common\n  - run: touch "${WORKTREE_PATH}/aliased"\npost_workspace_init: *common\n',
	);
	await fixture.run();
	t.true(fs.existsSync(path.join(fixture.workspace, 'aliased')));
});

test('a failing required command still stops setup before Claude starts', async t => {
	const fixture = setup(t);
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			post_workspace_init: [
				{run: 'false'},
				{run: 'touch "${WORKTREE_PATH}/unexpected"'},
			],
		}),
	);
	await t.throwsAsync(fixture.run());
	t.false(fs.existsSync(fixture.launchArgs));
	t.false(fs.existsSync(path.join(fixture.workspace, 'unexpected')));
});

test('adding commands does not add YAML parser processes', async t => {
	const fixture = setup(t);
	// Reopening an existing space reads its saved profile, which the first run
	// writes, so compare two reopens.
	await fixture.run();
	fs.writeFileSync(fixture.configCalls, '');
	await fixture.run();
	const count = fs
		.readFileSync(fixture.configCalls, 'utf8')
		.trim()
		.split('\n').length;
	fs.writeFileSync(fixture.configCalls, '');
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		YAML.dump({
			post_workspace_init: Array.from({length: 20}, () => ({run: ':'})),
		}),
	);
	await fixture.run();
	t.is(
		fs.readFileSync(fixture.configCalls, 'utf8').trim().split('\n').length,
		count,
	);
});

for (const consumer of ['profile vars', 'post-create hook']) {
	test(`PR lookup covers ${consumer}`, async t => {
		const fixture = setup(t);
		fs.appendFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			YAML.dump({
				profiles: {
					dev: {
						links: [],
						...(consumer === 'profile vars'
							? {
									vars: {
										SAVE_PR: 'printf "%s" "$PR_URL" > "${WORKTREE_PATH}/pr"',
									},
									commands: [{run: '${SAVE_PR}'}],
								}
							: {}),
					},
				},
				hooks: {
					post_workspace_create:
						consumer === 'post-create hook'
							? [{run: 'printf "%s" "${MR_URL}" > "${WORKTREE_PATH}/pr"'}]
							: [],
				},
			}),
		);
		await fixture.run({open: true});
		t.is(
			fs.readFileSync(path.join(fixture.workspace, 'pr'), 'utf8'),
			'https://github.com/test/repo/pull/1',
		);
	});
}

for (const consumer of ['links', 'apps']) {
	test.serial(
		`PR lookup sees YAML aliases in ${consumer} after merging layers`,
		async t => {
			const fixture = setup(t);
			const entry =
				consumer === 'links'
					? "  - url: '${PR_URL}'\n    if_set: PR_URL"
					: '  - name: Save PR\n    command: \'printf %s "${PR_URL}" > "${WORKTREE_PATH}/pr"\'\n    if_set: PR_URL';
			fs.writeFileSync(
				path.join(fixture.main, '.pappardelle.yml'),
				`common_entries: &entries\n${entry}\nversion: 1\nteam_prefix: test\nissue_tracker:\n  provider: beads\ndefault_profile: dev\nterminal:\n  app: none\nprofiles:\n  dev:\n${consumer === 'apps' ? '    links: []\n' : ''}    ${consumer}: *entries\n`,
			);
			const output = await fixture.run({open: true});
			const url = 'https://github.com/test/repo/pull/1';
			t.true(output.includes(`PR:        ${url}`), output);
			t.is(
				consumer === 'links'
					? fs.readFileSync(fixture.openCalls, 'utf8').trim()
					: fs.readFileSync(path.join(fixture.workspace, 'pr'), 'utf8'),
				url,
			);
		},
	);
}

test.serial(
	'a failed PR consumer inspection falls back to VCS lookup',
	async t => {
		const fixture = setup(t);
		fs.appendFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			YAML.dump({profiles: {dev: {links: []}}}),
		);
		const output = await fixture.run({
			open: true,
			extraEnv: {IDOW_TEST_FAIL_PR_INSPECTION: 'true'},
		});
		t.true(fs.existsSync(fixture.vcsCalls));
		t.true(output.includes('PR:        https://github.com/test/repo/pull/1'));
	},
);

test.serial('block-scalar launch settings strip trailing newlines', async t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		`claude:
  initialization_command: |+
    /do

  model: |
    opus
  effort: >
    high
companion_command: |
  echo companion
`,
	);
	await fixture.run();
	const args = fs
		.readFileSync(fixture.launchArgs, 'utf8')
		.split('\n')
		.slice(0, -1);
	for (const [flag, value] of [
		['--init-cmd', '/do'],
		['--agent-launch-flags', '--model opus --effort high'],
		['--companion-command', 'echo companion'],
	]) {
		t.true(args.includes(flag));
		t.is(args[args.indexOf(flag) + 1], value);
	}
});

test.serial(
	'block-scalar app/link conditions and titles keep the previous field behavior',
	async t => {
		const fixture = setup(t);
		fs.appendFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			`profiles:
  dev:
    apps:
      - name: |
          Block app
        command: |
          printf '%s' "\${PR_URL}" > "\${WORKTREE_PATH}/app"
        if_set: |
          PR_URL
    links:
      - title: |+
          Block link

        url: |
          \${PR_URL}
        if_set: |
          PR_URL
`,
		);
		const output = await fixture.run({open: true});
		const url = 'https://github.com/test/repo/pull/1';
		t.is(fs.readFileSync(path.join(fixture.workspace, 'app'), 'utf8'), url);
		t.is(fs.readFileSync(fixture.openCalls, 'utf8'), `${url}\n`);
		t.true(output.includes(`Link: Block link -> ${url}`), output);
		t.true(output.includes('Block app opened (command)'), output);
	},
);
