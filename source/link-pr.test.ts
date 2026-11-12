import test, {type ExecutionContext} from 'ava';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {linkPr, type LinkExecutor} from './link-pr.ts';
import {readPrLinkStamp} from './pr-link-stamp.ts';
import {discoverWorkspaceRepositories} from './providers/workspace-repositories.ts';

/** Stores for the repo named `workspace`, which every workspace here is in. */
function stores(t: ExecutionContext, sqlite?: boolean) {
	const {daos, stateDir} = testState(t, {repo: 'workspace', sqlite});
	const spaceStateFor = (repoName: string) => {
		t.is(repoName, 'workspace');
		return daos.spaceState;
	};

	return {
		spaceState: daos.spaceState,
		stateDir,
		options: {spaceStateFor, stampBaseDir: stateDir},
		discover: async (directory: string) =>
			discoverWorkspaceRepositories(directory, 'github.com', spaceStateFor),
	};
}

// With the database, link-pr is often the first write that finds a space's
// file: idow or an earlier Pappardelle saved the profile there.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: links a fork PR, preserves state, replaces repeated links and follows the published branch`, async t => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-'));
		t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
		const workspace = path.join(root, 'workspace');
		const {spaceState, stateDir: state, options, discover} = stores(t, sqlite);
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
		const file = spaceState.file('STE-24');
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(
			file,
			JSON.stringify({profile: 'codex', pipeline: 'passing'}),
		);
		const url = 'https://github.com/upstream/repo/pull/28';
		t.is(readPrLinkStamp(state), 0);
		const linked = await linkPr(url, workspace, workspace, {...options, run});
		t.is(linked.file, file);
		t.true(readPrLinkStamp(state) > 0);
		remoteBranch = 'published-again';
		await linkPr(url, workspace, workspace, {...options, run});
		for (const saved of [
			spaceState.read('STE-24')!,
			JSON.parse(fs.readFileSync(file, 'utf8')) as {prLinks?: unknown[]},
		]) {
			t.like(saved, {profile: 'codex', pipeline: 'passing'});
			t.is(saved.prLinks?.length, 1);
		}

		t.deepEqual(await discover(workspace), [
			{project: 'user/fork', branch: 'published-again'},
		]);
		git(['symbolic-ref', 'HEAD', 'refs/heads/other']);
		t.deepEqual(await discover(workspace), [
			{project: 'user/fork', branch: 'other'},
		]);
	});
}

test('links an upstream PR whose head is a fork added beside origin, and rejects a third repo', async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-upstream-'));
	t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const workspace = path.join(root, 'workspace');
	const {options, discover} = stores(t);
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
	t.deepEqual(await discover(workspace), [
		{project: 'user/fork', branch: 'published'},
	]);

	head = 'other/repo';
	await t.throwsAsync(linkPr(url, workspace, workspace, {...options, run}), {
		message: 'Run link-pr from the source repository (github.com/other/repo)',
	});
});

test('GitLab nested repositories retain independent branch mappings', async t => {
	const {spaceState, options} = stores(t);
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
	t.deepEqual(calls, [
		'projects/group%2Fsub%2Frepo/merge_requests/7',
		'projects/12',
	]);
	t.is(spaceState.read('ISSUE-1')?.prLinks?.length, 2);
});

test('failed verification and unrelated source repositories do not write state', async t => {
	const {stateDir, options} = stores(t);
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
			...options,
			run,
		}),
		{message: /source repository/},
	);
	await t.throwsAsync(
		linkPr('https://github.com/user/repo/pull/1', '/workspace', '/workspace', {
			...options,
			async run() {
				throw new Error('API unavailable');
			},
		}),
		{message: 'API unavailable'},
	);
	t.false(
		fs.existsSync(path.join(stateDir, 'repos', 'workspace', 'space-state')),
	);
	t.false(fs.existsSync(path.join(stateDir, 'pr-link.stamp')));
});
