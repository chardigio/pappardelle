/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
import {execFileSync} from 'node:child_process';
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
		'resolve-claude-config.sh',
	]) {
		fs.copyFileSync(path.join(scriptsDir, file), path.join(scripts, file));
	}
	writeScript(
		path.join(bin, 'bd'),
		`printf '%s\\n' '{"id":"test-abc","title":"Test issue","description":""}'`,
	);
	writeScript(path.join(bin, 'gh'), 'exit 1');
	writeScript(path.join(bin, 'tmux'), 'exit 1');
	writeScript(
		path.join(scripts, 'start-claude-session.sh'),
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
		config,
		run({open = false, projectRoot = true} = {}) {
			const env = {...process.env};
			delete env.PAPPARDELLE_PROJECT_ROOT;
			delete env.MAIN_REPO_ROOT;
			return execFileSync(
				'bash',
				[
					path.join(scripts, 'idow'),
					...(open ? ['--resume', '--open'] : []),
					'--existing-issue',
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
					},
				},
			);
		},
	};
}

test('idow creates a session using main config and worktree-local overrides', t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.local.yml'),
		'claude:\n  model: linked-model\n',
	);
	const output = fixture.run();
	t.true(output.includes('Workspace test-abc is ready!'), output);
	t.true(output.includes('Profile:   Main config'), output);
	t.true(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--model\nlinked-model\n'),
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

test('idow opens from a linked checkout and expands both repository roots', t => {
	const fixture = setup(t);
	const output = fixture.run({open: true, projectRoot: false});
	t.true(output.includes('Workspace test-abc is ready!'), output);
	t.true(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--model\nmain-model\n'),
	);
	t.is(
		fs.readFileSync(path.join(fixture.workspace, 'roots'), 'utf8'),
		`${fixture.main}\n${fixture.linked}\n`,
	);
});

test('idow prefers a worktree project config while falling back for local config', t => {
	const fixture = setup(t);
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.yml'),
		fixture.config('Linked config'),
	);
	const output = fixture.run();
	t.true(output.includes('Profile:   Linked config'), output);
	t.true(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--model\nmain-model\n'),
	);
});
