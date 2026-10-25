import test from 'ava';
import {GitLabProvider} from './providers/gitlab-provider.ts';

// ============================================================================
// GitLabProvider Unit Tests
// ============================================================================

test('GitLabProvider has name "gitlab"', t => {
	const provider = new GitLabProvider();
	t.is(provider.name, 'gitlab');
});

test('buildPRUrl for gitlab.com', async t => {
	const provider = new GitLabProvider();
	t.is(await provider.buildPRUrl(42), 'https://gitlab.com/-/merge_requests/42');
});

test('buildPRUrl for self-hosted', async t => {
	const provider = new GitLabProvider('gitlab.example.com');
	t.is(
		await provider.buildPRUrl(99),
		'https://gitlab.example.com/-/merge_requests/99',
	);
});

test('self-hosted configuration does not change the process environment', t => {
	const originalHost = process.env['GITLAB_HOST'];
	const _provider = new GitLabProvider('gitlab.example.com');
	t.is(process.env['GITLAB_HOST'], originalHost);
});

test('opening an MR returns its canonical URL without downloading a diff', async t => {
	const calls: string[][] = [];
	const provider = new GitLabProvider('gitlab.example.com', async args => {
		calls.push(args);
		return JSON.stringify([
			{
				iid: 42,
				web_url: 'https://gitlab.example.com/team/project/-/merge_requests/42',
			},
		]);
	});
	t.deepEqual(await provider.getPRLink('STA-42'), {
		number: 42,
		url: 'https://gitlab.example.com/team/project/-/merge_requests/42',
	});
	t.deepEqual(calls, [
		['mr', 'list', '--source-branch', 'STA-42', '-F', 'json'],
	]);
});

for (const diff of ['', 'diff --git a/file b/file\n+changed']) {
	test(`commit checking still inspects the MR diff: ${diff ? 'changed' : 'empty'}`, async t => {
		const calls: string[][] = [];
		const provider = new GitLabProvider(undefined, async args => {
			calls.push(args);
			return args[1] === 'list'
				? JSON.stringify([
						{
							iid: 42,
							web_url: 'https://gitlab.com/team/project/-/merge_requests/42',
						},
					])
				: diff;
		});
		const result = await provider.checkIssueHasPRWithCommits('STA-42');
		t.true(result.hasPR);
		t.is(result.hasCommits, Boolean(diff));
		t.deepEqual(calls[1], ['mr', 'diff', '42', '--color=never']);
	});
}

test('missing MR returns no link and skips diff checking', async t => {
	const calls: string[][] = [];
	const provider = new GitLabProvider(undefined, async args => {
		calls.push(args);
		return '[]';
	});
	t.is(await provider.getPRLink('STA-404'), null);
	t.deepEqual(await provider.checkIssueHasPRWithCommits('STA-404'), {
		hasPR: false,
		hasCommits: false,
	});
	t.true(calls.every(args => args[1] === 'list'));
});

test('MR lookup failures propagate for opening but preserve commit-check fallback', async t => {
	const provider = new GitLabProvider(undefined, async () => {
		throw new Error('glab unavailable');
	});
	await t.throwsAsync(provider.getPRLink('STA-1'), {
		message: 'glab unavailable',
	});
	t.deepEqual(await provider.checkIssueHasPRWithCommits('STA-1'), {
		hasPR: false,
		hasCommits: false,
	});
});

test('a failed diff lookup preserves the MR link', async t => {
	const provider = new GitLabProvider(undefined, async args => {
		if (args[1] === 'diff') throw new Error('diff unavailable');
		return JSON.stringify([
			{iid: 42, web_url: 'https://gitlab.com/team/project/-/merge_requests/42'},
		]);
	});
	t.deepEqual(await provider.checkIssueHasPRWithCommits('STA-42'), {
		hasPR: true,
		hasCommits: false,
		prNumber: 42,
		prUrl: 'https://gitlab.com/team/project/-/merge_requests/42',
	});
});
