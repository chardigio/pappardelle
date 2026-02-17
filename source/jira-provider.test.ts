import test from 'ava';
import {JiraProvider, mapJiraIssue} from './providers/jira-provider.ts';

// ============================================================================
// mapJiraIssue — pure parsing logic
// ============================================================================

test('mapJiraIssue extracts title from standard Jira response', t => {
	const raw = {
		key: 'CHEX-300',
		fields: {
			summary: 'Refactor OrderService for PRISM accept flow',
			status: {
				name: 'Done',
				statusCategory: {name: 'Done'},
			},
		},
	};
	const issue = mapJiraIssue(raw);
	t.is(issue.identifier, 'CHEX-300');
	t.is(issue.title, 'Refactor OrderService for PRISM accept flow');
	t.is(issue.state.name, 'Done');
	t.is(issue.state.color, '#4caf50');
});

test('mapJiraIssue handles missing project field', t => {
	const raw = {
		key: 'CHEX-123',
		fields: {
			summary: 'Fix bug',
			status: {name: 'In Progress', statusCategory: {name: 'In Progress'}},
		},
	};
	const issue = mapJiraIssue(raw);
	t.is(issue.title, 'Fix bug');
	t.is(issue.project, null);
});

test('mapJiraIssue maps statusCategory to color', t => {
	const raw = {
		key: 'CHEX-1',
		fields: {
			summary: 'Task',
			status: {name: 'To Do', statusCategory: {name: 'To Do'}},
		},
	};
	t.is(mapJiraIssue(raw).state.color, '#95a2b3');
});

// ============================================================================
// getIssue + getIssueCached — CLI integration via injected executor
// ============================================================================

function makeJiraResponse(
	key: string,
	summary: string,
	statusName = 'In Progress',
	categoryName = 'In Progress',
) {
	return JSON.stringify({
		key,
		fields: {
			summary,
			status: {
				name: statusName,
				statusCategory: {name: categoryName},
			},
		},
	});
}

test('getIssue populates cache and getIssueCached returns issue', async t => {
	const json = makeJiraResponse('CHEX-100', 'Add feature X');
	const provider = new JiraProvider('https://example.com', () => json);

	const issue = await provider.getIssue('CHEX-100');
	t.truthy(issue);
	t.is(issue!.title, 'Add feature X');

	const cached = provider.getIssueCached('CHEX-100');
	t.truthy(cached);
	t.is(cached!.title, 'Add feature X');
});

test('getIssue extracts issue when CLI exits non-zero but stdout has valid JSON', async t => {
	// acli returns valid JSON but exits with code 1 — execFileSync throws
	const json = makeJiraResponse('CHEX-200', 'Fix authentication bug');
	const provider = new JiraProvider('https://example.com', () => {
		const err = new Error('Command failed: exit code 1') as Error & {
			stdout: string;
			status: number;
		};
		err.stdout = json;
		err.status = 1;
		throw err;
	});

	const issue = await provider.getIssue('CHEX-200');
	t.truthy(issue, 'should extract issue from error.stdout');
	t.is(issue!.title, 'Fix authentication bug');

	const cached = provider.getIssueCached('CHEX-200');
	t.truthy(cached, 'cache should have the issue');
	t.is(cached!.title, 'Fix authentication bug');
});

test('getIssue returns null when CLI truly fails (no stdout)', async t => {
	const provider = new JiraProvider('https://example.com', () => {
		throw new Error('ENOENT: acli not found');
	});

	const issue = await provider.getIssue('CHEX-999');
	t.is(issue, null);
	t.is(provider.getIssueCached('CHEX-999'), null);
});

// ============================================================================
// Existing unit tests
// ============================================================================

test('JiraProvider has name "jira"', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(provider.name, 'jira');
});

test('buildIssueUrl uses base_url', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(
		provider.buildIssueUrl('PROJ-123'),
		'https://mycompany.atlassian.net/browse/PROJ-123',
	);
});

test('buildIssueUrl strips trailing slash from base_url', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net/');
	t.is(
		provider.buildIssueUrl('PROJ-456'),
		'https://mycompany.atlassian.net/browse/PROJ-456',
	);
});

test('getIssueCached returns null for uncached issues', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(provider.getIssueCached('PROJ-999'), null);
});

test('getWorkflowStateColor returns null for unknown state', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(provider.getWorkflowStateColor('Unknown State'), null);
});

// ============================================================================
// getWorkflowStateColor: static fallback for known Jira status categories
// Before any issues are fetched, the color cache is empty. But for well-known
// Jira status categories ("To Do", "In Progress", "Done"), the provider should
// return its static STATUS_CATEGORY_COLORS so the main worktree row can be
// colored correctly without needing to fetch an issue first.
// ============================================================================

test('getWorkflowStateColor returns blue for "In Progress" without any fetched issues', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	const color = provider.getWorkflowStateColor('In Progress');
	t.is(color, '#4b9fea');
});

test('getWorkflowStateColor returns green for "Done" without any fetched issues', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	const color = provider.getWorkflowStateColor('Done');
	t.is(color, '#4caf50');
});

test('getWorkflowStateColor returns gray for "To Do" without any fetched issues', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	const color = provider.getWorkflowStateColor('To Do');
	t.is(color, '#95a2b3');
});

test('clearCache does not throw', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.notThrows(() => provider.clearCache());
});
