/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
// A checkout, a copy of the idow scripts with their slow or host-touching
// steps stubbed, and a run of idow against them, for the idow-*.test.ts files.
import {execFile, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stringify} from 'yaml';
import {teardown} from './teardown.ts';

const scriptsDir = path.resolve(import.meta.dirname, '../../scripts');

export function writeScript(filename: string, body: string) {
	const script = `#!/bin/bash\nset -e\n${body}\n`;
	execFileSync('shellcheck', ['-s', 'bash', '-'], {input: script});
	fs.writeFileSync(filename, script, {mode: 0o755});
}

export function setup(realWorktree = false) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'idow-config-')),
	);
	teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const main = path.join(root, 'main checkout');
	const linked = path.join(root, 'linked checkout');
	const scripts = path.join(root, 'scripts');
	const bin = path.join(root, 'bin');
	const home = path.join(root, 'home');
	const workspace = path.join(
		home,
		'.worktrees',
		path.basename(main),
		'test-abc',
	);
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
		'state-cli.sh',
		'resolve-agent-config.sh',
		'builtin-agents.json',
		'resolve-terminal-app.sh',
		'derive-title.sh',
		'companion-rules.txt',
		'install-agent-rules.sh',
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
	// idow records state through the binary. The copied scripts have no build
	// or sources beside them, so the fixture runs this checkout's state CLI.
	const stateCli = path.join(bin, 'pappardelle-state');
	writeScript(
		stateCli,
		`shift
exec ${JSON.stringify(process.execPath)} --no-env-file --config=/dev/null ${JSON.stringify(path.resolve(import.meta.dirname, '../../source/state-cli.ts'))} "$@"`,
	);
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
		`while [[ "$1" != --worktree ]]; do shift; done
mkdir -p "$2"
jq -n --arg worktree_path "$2" '{worktree_path: $worktree_path}'`,
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
		stringify({
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
			cwd,
		}: {
			open?: boolean;
			projectRoot?: boolean;
			/** Where idow runs, in place of the one projectRoot picks. */
			cwd?: string;
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
						cwd: cwd ?? (projectRoot ? root : linked),
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
							PAPPARDELLE_EXECUTABLE: stateCli,
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
