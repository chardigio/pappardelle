import test from 'ava';
import {
	createIssueTracker,
	createVcsHost,
	resetProviders,
} from './providers/index.ts';

// Tests must be serial because they share singleton state
test.beforeEach(() => {
	resetProviders();
});

// ============================================================================
// Factory: Issue Tracker
// ============================================================================

test.serial('createIssueTracker defaults to LinearProvider', t => {
	const provider = createIssueTracker();
	t.is(provider.name, 'linear');
});

test.serial(
	'createIssueTracker returns LinearProvider for explicit linear config',
	t => {
		const provider = createIssueTracker({provider: 'linear'});
		t.is(provider.name, 'linear');
	},
);

test.serial(
	'createIssueTracker returns JiraProvider for jira config with base_url',
	t => {
		const provider = createIssueTracker({
			provider: 'jira',
			base_url: 'https://mycompany.atlassian.net',
		});
		t.is(provider.name, 'jira');
	},
);

test.serial('createIssueTracker throws for jira without base_url', t => {
	t.throws(() => createIssueTracker({provider: 'jira'}), {
		message: /base_url is required/,
	});
});

test.serial('createIssueTracker throws for unknown provider', t => {
	t.throws(
		// @ts-expect-error testing invalid input
		() => createIssueTracker({provider: 'unknown'}),
		{message: /Unknown issue tracker provider/},
	);
});

test.serial('createIssueTracker returns singleton', t => {
	const a = createIssueTracker();
	const b = createIssueTracker();
	t.is(a, b);
});

// ============================================================================
// Factory: VCS Host
// ============================================================================

test.serial('createVcsHost defaults to GitHubProvider', t => {
	const provider = createVcsHost();
	t.is(provider.name, 'github');
});

test.serial(
	'createVcsHost returns GitHubProvider for explicit github config',
	t => {
		const provider = createVcsHost({provider: 'github'});
		t.is(provider.name, 'github');
	},
);

test.serial('createVcsHost returns GitLabProvider for gitlab config', t => {
	const provider = createVcsHost({provider: 'gitlab'});
	t.is(provider.name, 'gitlab');
});

test.serial('createVcsHost throws for unknown provider', t => {
	t.throws(
		// @ts-expect-error testing invalid input
		() => createVcsHost({provider: 'unknown'}),
		{message: /Unknown VCS host provider/},
	);
});

test.serial('createVcsHost returns singleton', t => {
	const a = createVcsHost();
	const b = createVcsHost();
	t.is(a, b);
});

// ============================================================================
// resetProviders
// ============================================================================

test.serial('resetProviders clears cached singletons', t => {
	const a = createIssueTracker();
	resetProviders();
	const b = createIssueTracker();
	t.not(a, b);
	t.is(a.name, b.name);
});
