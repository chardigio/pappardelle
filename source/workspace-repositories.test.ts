import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {discoverWorkspaceRepositories} from './providers/workspace-repositories.ts';
import {remoteProject} from './git-remotes.ts';

test('parses GitLab remotes including subgroups and rejects other hosts', () => {
	for (const remote of [
		'git@gitlab.example.com:group/sub/repo.git',
		'ssh://git@gitlab.example.com:2222/group/sub/repo.git',
		'https://gitlab.example.com/group/sub/repo.git',
	])
		expect(remoteProject(remote, 'gitlab.example.com')).toBe('group/sub/repo');
	expect(
		remoteProject('git@github.com:group/repo.git', 'gitlab.example.com'),
	).toBe(null);
	expect(remoteProject('/local/repo', 'gitlab.example.com')).toBe(null);
});

test('parses GitHub SSH and HTTPS remotes, including enterprise hosts', () => {
	for (const host of ['github.com', 'github.example.com']) {
		for (const remote of [
			`git@${host}:owner/repo.git`,
			`ssh://git@${host}/owner/repo.git`,
			`https://${host}/owner/repo`,
		])
			expect(remoteProject(remote, host)).toBe('owner/repo');
	}
	expect(remoteProject('git@gitlab.com:owner/repo.git', 'github.com')).toBe(
		null,
	);
});

test('discovers root and nested clones/worktrees, skips dependencies and symlinks, rereads branches', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'rail-repos-'));
	teardown(async () => rm(root, {recursive: true, force: true}));
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
	expect(await discoverWorkspaceRepositories(root, 'github.com')).toStrictEqual(
		[{project: 'rex/other', branch: 'sd-actual-branch'}],
	);
	expect(first).toStrictEqual([
		{project: 'user/workspace', branch: 'sd-actual-branch'},
		{project: 'rex/agent', branch: 'sd-actual-branch'},
		{project: 'rex/agent', branch: 'sd-worktree'},
	]);
	git(nested, ['switch', '-c', 'sd-new-branch']);
	const second = await discoverWorkspaceRepositories(
		root,
		'gitlab.example.com',
	);
	expect(second.some(repo => repo.branch === 'sd-new-branch')).toBe(true);
	expect(
		second.some(
			repo =>
				repo.project === 'rex/agent' && repo.branch === 'sd-actual-branch',
		),
	).toBe(false);
});
