import test from 'ava';
import {GitLabProvider} from './providers/gitlab-provider.ts';

// ============================================================================
// GitLabProvider Unit Tests
// Note: Tests that call CLI commands (checkIssueHasPRWithCommits) are not
// tested here since they depend on `glab` being installed. We test pure logic.
// ============================================================================

test('GitLabProvider has name "gitlab"', t => {
	const provider = new GitLabProvider();
	t.is(provider.name, 'gitlab');
});

test('buildPRUrl for gitlab.com', t => {
	const provider = new GitLabProvider();
	t.is(provider.buildPRUrl(42), 'https://gitlab.com/-/merge_requests/42');
});

test('buildPRUrl for self-hosted', t => {
	const provider = new GitLabProvider('gitlab.example.com');
	t.is(
		provider.buildPRUrl(99),
		'https://gitlab.example.com/-/merge_requests/99',
	);
});

test('self-hosted sets GITLAB_HOST env', t => {
	const _provider = new GitLabProvider('gitlab.example.com');
	t.is(process.env['GITLAB_HOST'], 'gitlab.example.com');
	// Clean up
	delete process.env['GITLAB_HOST'];
});

test('no host does not set GITLAB_HOST env', t => {
	delete process.env['GITLAB_HOST'];
	const _provider = new GitLabProvider();
	t.is(process.env['GITLAB_HOST'], undefined);
});
