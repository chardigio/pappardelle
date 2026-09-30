import test from 'ava';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {linkPr, type LinkExecutor} from './link-pr.ts';
import {readSpaceState, writeSpaceState} from './space-state.ts';
import {discoverWorkspaceRepositories} from './providers/workspace-repositories.ts';

test('links a fork PR, preserves state, replaces repeated links and follows the published branch', async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-'));
	t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const workspace = path.join(root, 'workspace');
	const state = path.join(root, 'state');
	fs.mkdirSync(workspace);
	const git = (args: string[]) =>
		execFileSync('git', args, {cwd: workspace, encoding: 'utf-8'}).trim();
	git(['init', '-b', 'STE-24']);
	git(['remote', 'add', 'origin', 'git@github.com:user/fork.git']);
	let remoteBranch = 'published';
	const run: LinkExecutor = async (command, args) => {
		if (command === 'git') return git(args);
		t.is(command, 'gh');
		t.deepEqual(args, [
			'api',
			'--hostname',
			'github.com',
			'repos/upstream/repo/pulls/28',
		]);
		return JSON.stringify({
			state: 'open',
			number: 28,
			head: {ref: remoteBranch, repo: {full_name: 'user/fork'}},
		});
	};
	writeSpaceState(
		'workspace',
		'STE-24',
		{profile: 'codex', pipeline: 'passing'},
		state,
	);
	const url = 'https://github.com/upstream/repo/pull/28';
	await linkPr(url, workspace, workspace, {run, baseDir: state});
	remoteBranch = 'published-again';
	await linkPr(url, workspace, workspace, {run, baseDir: state});
	const saved = readSpaceState('workspace', 'STE-24', state)!;
	t.is(saved.profile, 'codex');
	t.is(saved.pipeline, 'passing');
	t.is(saved.prLinks?.length, 1);
	t.deepEqual(
		await discoverWorkspaceRepositories(workspace, 'github.com', state),
		[{project: 'user/fork', branch: 'published-again'}],
	);
	git(['symbolic-ref', 'HEAD', 'refs/heads/other']);
	t.deepEqual(
		await discoverWorkspaceRepositories(workspace, 'github.com', state),
		[{project: 'user/fork', branch: 'other'}],
	);
});

test('GitLab nested repositories retain independent branch mappings', async t => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'link-mr-'));
	t.teardown(() => fs.rmSync(base, {recursive: true, force: true}));
	const calls: string[] = [];
	const run: LinkExecutor = async (command, args, cwd) => {
		if (command === 'glab') {
			t.is(args[2], 'gitlab.example.com');
			calls.push(args.at(-1)!);
			return JSON.stringify(
				args.at(-1)!.includes('merge_requests')
					? {
							state: 'opened',
							iid: 7,
							source_project_id: 12,
							source_branch: 'published',
							web_url:
								'https://gitlab-web.example.com/group/sub/repo/-/merge_requests/7',
						}
					: {path_with_namespace: 'group/sub/repo'},
			);
		}
		if (args[0] === 'remote')
			return 'git@gitlab.example.com:group/sub/repo.git';
		if (args[0] === 'rev-parse') return '/repos/workspace/.git';
		return cwd === '/workspace' ? 'ISSUE-1' : 'local';
	};
	writeSpaceState(
		'workspace',
		'ISSUE-1',
		{
			prLinks: [
				{
					host: 'gitlab.example.com',
					project: 'group/other',
					localBranch: 'local',
					remoteBranch: 'other',
					url: 'https://gitlab.example.com/group/other/-/merge_requests/8',
					number: 8,
				},
			],
		},
		base,
	);
	await linkPr(
		'https://gitlab-web.example.com/group/sub/repo/-/merge_requests/7',
		'/workspace/src/repo',
		'/workspace',
		{run, baseDir: base, gitlabHost: 'gitlab.example.com'},
	);
	t.deepEqual(calls, [
		'projects/group%2Fsub%2Frepo/merge_requests/7',
		'projects/12',
	]);
	t.is(readSpaceState('workspace', 'ISSUE-1', base)?.prLinks?.length, 2);
});

test('failed verification and unrelated source repositories do not write state', async t => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'link-invalid-'));
	t.teardown(() => fs.rmSync(base, {recursive: true, force: true}));
	const run: LinkExecutor = async command => {
		if (command === 'gh')
			return JSON.stringify({
				state: 'open',
				number: 1,
				head: {ref: 'feature', repo: {full_name: 'other/repo'}},
			});
		return 'git@github.com:user/repo.git';
	};
	await t.throwsAsync(
		linkPr('https://github.com/user/repo/pull/1', '/workspace', '/workspace', {
			run,
			baseDir: base,
		}),
		{message: /source repository/},
	);
	await t.throwsAsync(
		linkPr('https://github.com/user/repo/pull/1', '/workspace', '/workspace', {
			async run() {
				throw new Error('API unavailable');
			},
			baseDir: base,
		}),
		{message: 'API unavailable'},
	);
	t.deepEqual(fs.readdirSync(base), []);
});
