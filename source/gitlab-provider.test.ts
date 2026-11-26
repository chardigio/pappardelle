import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {GitLabProvider} from './providers/gitlab-provider.ts';

// ============================================================================
// GitLabProvider Unit Tests
// ============================================================================

test('GitLabProvider has name "gitlab"', () => {
	const provider = new GitLabProvider();
	expect(provider.name).toBe('gitlab');
});

test('buildPRUrl for gitlab.com', async () => {
	const provider = new GitLabProvider();
	expect(await provider.buildPRUrl(42)).toBe(
		'https://gitlab.com/-/merge_requests/42',
	);
});

test('buildPRUrl for self-hosted', async () => {
	const provider = new GitLabProvider('gitlab.example.com');
	expect(await provider.buildPRUrl(99)).toBe(
		'https://gitlab.example.com/-/merge_requests/99',
	);
});

test('self-hosted configuration does not change the process environment', async () => {
	const originalHost = process.env['GITLAB_HOST'];
	const provider = new GitLabProvider('gitlab.example.com');
	expect(await provider.buildPRUrl(1)).toBe(
		'https://gitlab.example.com/-/merge_requests/1',
	);
	expect(process.env['GITLAB_HOST']).toBe(originalHost);
});

test('opening an MR returns its canonical URL without downloading a diff', async () => {
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
	expect(await provider.getPRLink('STA-42')).toStrictEqual({
		number: 42,
		url: 'https://gitlab.example.com/team/project/-/merge_requests/42',
	});
	expect(calls).toStrictEqual([
		['mr', 'list', '--source-branch', 'STA-42', '-F', 'json'],
	]);
});

for (const diff of ['', 'diff --git a/file b/file\n+changed']) {
	test(`commit checking still inspects the MR diff: ${diff ? 'changed' : 'empty'}`, async () => {
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
		expect(result.hasPR).toBe(true);
		expect(result.hasCommits).toBe(Boolean(diff));
		expect(calls[1]).toStrictEqual(['mr', 'diff', '42', '--color=never']);
	});
}

test('missing MR returns no link and skips diff checking', async () => {
	const calls: string[][] = [];
	const provider = new GitLabProvider(undefined, async args => {
		calls.push(args);
		return '[]';
	});
	expect(await provider.getPRLink('STA-404')).toBe(null);
	expect(await provider.checkIssueHasPRWithCommits('STA-404')).toStrictEqual({
		hasPR: false,
		hasCommits: false,
	});
	expect(calls.every(args => args[1] === 'list')).toBe(true);
});

test('MR lookup failures propagate for opening but preserve commit-check fallback', async () => {
	const provider = new GitLabProvider(undefined, async () => {
		throw new Error('glab unavailable');
	});
	await rejectionOf(provider.getPRLink('STA-1')).then(error => {
		expect(error.message).toBe('glab unavailable');
	});
	expect(await provider.checkIssueHasPRWithCommits('STA-1')).toStrictEqual({
		hasPR: false,
		hasCommits: false,
	});
});

test('a failed diff lookup preserves the MR link', async () => {
	const provider = new GitLabProvider(undefined, async args => {
		if (args[1] === 'diff') throw new Error('diff unavailable');
		return JSON.stringify([
			{iid: 42, web_url: 'https://gitlab.com/team/project/-/merge_requests/42'},
		]);
	});
	expect(await provider.checkIssueHasPRWithCommits('STA-42')).toStrictEqual({
		hasPR: true,
		hasCommits: false,
		prNumber: 42,
		prUrl: 'https://gitlab.com/team/project/-/merge_requests/42',
	});
});
