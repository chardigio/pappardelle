import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {linkPr, type LinkExecutor} from './link-pr.ts';
import {discoverWorkspaceRepositories} from './providers/workspace-repositories.ts';

/** Stores for the repo named `workspace`, which every workspace here is in. */
function stores() {
	const {daos, stateDir} = testState({repo: 'workspace'});
	const spaceStateFor = (repoName: string) => {
		expect(repoName).toBe('workspace');
		return daos.spaceState;
	};

	return {
		spaceState: daos.spaceState,
		prLinkStamp: daos.prLinkStamp,
		stateDir,
		options: {
			daosFor(repoName: string) {
				expect(repoName).toBe('workspace');
				return daos;
			},
		},
		discover: async (directory: string) =>
			discoverWorkspaceRepositories(directory, 'github.com', spaceStateFor),
	};
}

test('links a fork PR, preserves state, replaces repeated links and follows the published branch', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-'));
	teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const workspace = path.join(root, 'workspace');
	const {spaceState, prLinkStamp, options, discover} = stores();
	fs.mkdirSync(workspace);
	const git = (args: string[]) =>
		execFileSync('git', args, {cwd: workspace, encoding: 'utf-8'}).trim();
	git(['init', '-b', 'STE-24']);
	git(['remote', 'add', 'origin', 'git@github.com:user/fork.git']);
	let remoteBranch = 'published';
	const run: LinkExecutor = async (command, args) => {
		if (command === 'git') return git(args);
		expect(command).toBe('gh');
		expect(args).toStrictEqual([
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
	await spaceState.write('STE-24', {profile: 'codex', pipeline: 'passing'});
	const url = 'https://github.com/upstream/repo/pull/28';
	expect(prLinkStamp.read()).toBe(0);
	const linked = await linkPr(url, workspace, workspace, {...options, run});
	expect(linked).toMatchObject({
		issueKey: 'STE-24',
		link: {project: 'user/fork', remoteBranch: 'published', number: 28},
	});
	expect(prLinkStamp.read() > 0).toBe(true);
	remoteBranch = 'published-again';
	await linkPr(url, workspace, workspace, {...options, run});
	const saved = spaceState.read('STE-24');
	expect(saved).toMatchObject({profile: 'codex', pipeline: 'passing'});
	expect(saved?.prLinks?.length).toBe(1);

	expect(await discover(workspace)).toStrictEqual([
		{project: 'user/fork', branch: 'published-again'},
	]);
	git(['symbolic-ref', 'HEAD', 'refs/heads/other']);
	expect(await discover(workspace)).toStrictEqual([
		{project: 'user/fork', branch: 'other'},
	]);
});

test('links an upstream PR whose head is a fork added beside origin, and rejects a third repo', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-upstream-'));
	teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const workspace = path.join(root, 'workspace');
	const {options, discover} = stores();
	fs.mkdirSync(workspace);
	const git = (args: string[]) =>
		execFileSync('git', args, {cwd: workspace, encoding: 'utf-8'}).trim();
	git(['init', '-b', 'STE-24']);
	git(['remote', 'add', 'origin', 'git@github.com:upstream/repo.git']);
	git(['remote', 'add', 'fork', 'git@github.com:user/fork']);
	let head = 'user/fork';
	const run: LinkExecutor = async (command, args) => {
		if (command === 'git') return git(args);
		// Trimmed from `gh api repos/chardigio/pappardelle/pulls/58`.
		return JSON.stringify({
			base: {ref: 'main', repo: {full_name: 'upstream/repo'}},
			head: {ref: 'published', repo: {full_name: head}},
			number: 28,
			state: 'open',
		});
	};
	const url = 'https://github.com/upstream/repo/pull/28';
	await linkPr(url, workspace, workspace, {...options, run});
	expect(await discover(workspace)).toStrictEqual([
		{project: 'user/fork', branch: 'published'},
	]);

	head = 'other/repo';
	await rejectionOf(linkPr(url, workspace, workspace, {...options, run})).then(
		error => {
			expect(error.message).toBe(
				'Run link-pr from the source repository (github.com/other/repo)',
			);
		},
	);
});

test('GitLab nested repositories retain independent branch mappings', async () => {
	const {spaceState, options} = stores();
	const calls: string[] = [];
	const run: LinkExecutor = async (command, args, cwd) => {
		if (command === 'glab') {
			expect(args[2]).toBe('gitlab.example.com');
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
		if (args[0] === 'config')
			return 'remote.origin.url git@gitlab.example.com:group/sub/repo.git';
		if (args[0] === 'rev-parse') return '/repos/workspace/.git';
		return cwd === '/workspace' ? 'ISSUE-1' : 'local';
	};
	await spaceState.addPrLink('ISSUE-1', {
		host: 'gitlab.example.com',
		project: 'group/other',
		localBranch: 'local',
		remoteBranch: 'other',
		url: 'https://gitlab.example.com/group/other/-/merge_requests/8',
		number: 8,
	});
	await linkPr(
		'https://gitlab-web.example.com/group/sub/repo/-/merge_requests/7',
		'/workspace/src/repo',
		'/workspace',
		{...options, run, gitlabHost: 'gitlab.example.com'},
	);
	expect(calls).toStrictEqual([
		'projects/group%2Fsub%2Frepo/merge_requests/7',
		'projects/12',
	]);
	expect(spaceState.read('ISSUE-1')?.prLinks?.length).toBe(2);
});

test('failed verification and unrelated source repositories do not write state', async () => {
	const {stateDir, options} = stores();
	const run: LinkExecutor = async command => {
		if (command === 'gh')
			return JSON.stringify({
				state: 'open',
				number: 1,
				head: {ref: 'feature', repo: {full_name: 'other/repo'}},
			});
		return 'git@github.com:user/repo.git';
	};
	expect(
		await rejectionOf(
			linkPr(
				'https://github.com/user/repo/pull/1',
				'/workspace',
				'/workspace',
				{
					...options,
					run,
				},
			),
		),
	).toHaveProperty('message', expect.stringMatching(/source repository/));
	await rejectionOf(
		linkPr('https://github.com/user/repo/pull/1', '/workspace', '/workspace', {
			...options,
			async run() {
				throw new Error('API unavailable');
			},
		}),
	).then(error => {
		expect(error.message).toBe('API unavailable');
	});
	expect(
		fs.existsSync(path.join(stateDir, 'repos', 'workspace', 'space-state')),
	).toBe(false);
	expect(fs.existsSync(path.join(stateDir, 'pr-link.stamp'))).toBe(false);
});
