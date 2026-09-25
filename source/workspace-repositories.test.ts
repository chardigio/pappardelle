import test from 'ava';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	discoverWorkspaceRepositories,
	remoteProject,
} from './providers/workspace-repositories.ts';

test('parses GitLab remotes including subgroups and rejects other hosts', t => {
	for (const remote of [
		'git@gitlab.example.com:group/sub/repo.git',
		'ssh://git@gitlab.example.com:2222/group/sub/repo.git',
		'https://gitlab.example.com/group/sub/repo.git',
	])
		t.is(remoteProject(remote, 'gitlab.example.com'), 'group/sub/repo');
	t.is(
		remoteProject('git@github.com:group/repo.git', 'gitlab.example.com'),
		null,
	);
	t.is(remoteProject('/local/repo', 'gitlab.example.com'), null);
});

test('parses GitHub SSH and HTTPS remotes, including enterprise hosts', t => {
	for (const host of ['github.com', 'github.example.com']) {
		for (const remote of [
			`git@${host}:owner/repo.git`,
			`ssh://git@${host}/owner/repo.git`,
			`https://${host}/owner/repo`,
		])
			t.is(remoteProject(remote, host), 'owner/repo');
	}
	t.is(remoteProject('git@gitlab.com:owner/repo.git', 'github.com'), null);
});

test('discovers root and nested clones/worktrees, skips dependencies and symlinks, rereads branches', async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'rail-repos-'));
	t.teardown(async () => rm(root, {recursive: true, force: true}));
	const git = (cwd: string, args: string[]) =>
		execFileSync('git', ['-C', cwd, ...args], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	async function init(relative: string, project: string) {
		const cwd = path.join(root, relative);
		await mkdir(cwd, {recursive: true});
		git(cwd, ['init', '-b', 'sd-actual-branch']);
		git(cwd, [
			'remote',
			'add',
			'origin',
			`git@gitlab.example.com:${project}.git`,
		]);
		return cwd;
	}
	await init('.', 'user/workspace');
	const nested = await init('src/agent', 'rex/agent');
	await init('node_modules/ignored', 'rex/ignored');
	const other = await init('src/other', 'rex/other');
	git(other, ['remote', 'set-url', 'origin', 'git@github.com:rex/other.git']);
	await symlink(nested, path.join(root, 'linked'));
	git(nested, [
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.com',
		'-c',
		'core.hooksPath=/dev/null',
		'commit',
		'--allow-empty',
		'-m',
		'fixture',
	]);
	git(nested, [
		'worktree',
		'add',
		'-b',
		'sd-worktree',
		path.join(root, 'src/worktree'),
	]);
	const first = await discoverWorkspaceRepositories(root, 'gitlab.example.com');
	t.deepEqual(await discoverWorkspaceRepositories(root, 'github.com'), [
		{project: 'rex/other', branch: 'sd-actual-branch'},
	]);
	t.deepEqual(first, [
		{project: 'user/workspace', branch: 'sd-actual-branch'},
		{project: 'rex/agent', branch: 'sd-actual-branch'},
		{project: 'rex/agent', branch: 'sd-worktree'},
	]);
	git(nested, ['switch', '-c', 'sd-new-branch']);
	const second = await discoverWorkspaceRepositories(
		root,
		'gitlab.example.com',
	);
	t.true(second.some(repo => repo.branch === 'sd-new-branch'));
	t.false(
		second.some(
			repo =>
				repo.project === 'rex/agent' && repo.branch === 'sd-actual-branch',
		),
	);
});
