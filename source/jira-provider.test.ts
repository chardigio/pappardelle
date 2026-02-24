import test from 'ava';
import {
	JiraProvider,
	MAX_RETRIES,
	mapJiraIssue,
	type CliExecutor,
	type SleepFn,
} from './providers/jira-provider.ts';

function makeEnoentError(): Error & {code: string} {
	const err = new Error('spawn acli ENOENT') as Error & {code: string};
	err.code = 'ENOENT';
	return err;
}

// No-op sleep so tests don't wait
const noopSleep: SleepFn = async () => {};

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
	const provider = new JiraProvider(
		'https://example.com',
		() => {
			throw new Error('Connection refused');
		},
		noopSleep,
	);

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

// ============================================================================
// getIssue: retry logic
// ============================================================================

test('getIssue succeeds on first attempt — no retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		return makeJiraResponse('CHEX-100', 'First try');
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const issue = await provider.getIssue('CHEX-100');

	t.is(callCount, 1);
	t.truthy(issue);
	t.is(issue!.title, 'First try');
	t.is(issue!.identifier, 'CHEX-100');
});

test('getIssue fails once then succeeds on retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		if (callCount === 1) {
			throw new Error('Connection timed out');
		}

		return makeJiraResponse('CHEX-200', 'Retry success');
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const issue = await provider.getIssue('CHEX-200');

	t.is(callCount, 2);
	t.truthy(issue);
	t.is(issue!.title, 'Retry success');
});

test('getIssue fails all retries — returns null and caches null', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		throw new Error('Network unreachable');
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const issue = await provider.getIssue('CHEX-300');

	t.is(callCount, MAX_RETRIES);
	t.is(issue, null);
	t.is(provider.getIssueCached('CHEX-300'), null);
});

test('getIssue with ENOENT — fails immediately, no retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const issue = await provider.getIssue('CHEX-400');

	t.is(callCount, 1, 'should not retry on ENOENT');
	t.is(issue, null);
});

test('getIssue with ENOENT — subsequent calls return cached without CLI call', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	await provider.getIssue('CHEX-410');
	t.is(callCount, 1);

	// Second call should not invoke exec at all
	const issue2 = await provider.getIssue('CHEX-420');
	t.is(callCount, 1, 'acliMissing should prevent further calls');
	t.is(issue2, null);
});

test('getIssue sleep is called between retries, not after final attempt', async t => {
	const sleepCalls: number[] = [];
	const sleepSpy: SleepFn = async (ms: number) => {
		sleepCalls.push(ms);
	};

	const exec: CliExecutor = () => {
		throw new Error('Timeout');
	};

	const provider = new JiraProvider('https://example.com', exec, sleepSpy);
	await provider.getIssue('CHEX-500');

	t.is(
		sleepCalls.length,
		MAX_RETRIES - 1,
		'sleep should be called between retries only',
	);
	for (const ms of sleepCalls) {
		t.is(ms, 500, 'sleep delay should be RETRY_DELAY_MS');
	}
});

test('getIssue extracts issue from non-zero exit stdout without retrying', async t => {
	let callCount = 0;
	const json = makeJiraResponse('CHEX-600', 'Stdout extraction');
	const exec: CliExecutor = () => {
		callCount++;
		const err = new Error('Command failed: exit code 1') as Error & {
			stdout: string;
			status: number;
		};
		err.stdout = json;
		err.status = 1;
		throw err;
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const issue = await provider.getIssue('CHEX-600');

	t.is(callCount, 1, 'should not retry when stdout has valid JSON');
	t.truthy(issue);
	t.is(issue!.title, 'Stdout extraction');
});

test('getIssue returns cached result within TTL without calling CLI', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		return makeJiraResponse('CHEX-700', 'Cached');
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	await provider.getIssue('CHEX-700');
	t.is(callCount, 1);

	// Second call should use cache
	const issue2 = await provider.getIssue('CHEX-700');
	t.is(callCount, 1, 'should not call CLI again within TTL');
	t.truthy(issue2);
	t.is(issue2!.title, 'Cached');
});

// ============================================================================
// createComment: retry logic
// ============================================================================

test('createComment succeeds on first attempt', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		return '';
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const result = await provider.createComment('CHEX-100', 'Hello');

	t.is(callCount, 1);
	t.true(result);
});

test('createComment fails once then succeeds on retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		if (callCount === 1) {
			throw new Error('Timeout');
		}

		return '';
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const result = await provider.createComment('CHEX-200', 'Hello');

	t.is(callCount, 2);
	t.true(result);
});

test('createComment fails all retries — returns false', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		throw new Error('Network error');
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const result = await provider.createComment('CHEX-300', 'Hello');

	t.is(callCount, MAX_RETRIES);
	t.false(result);
});

test('createComment with ENOENT — fails immediately, no retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider('https://example.com', exec, noopSleep);
	const result = await provider.createComment('CHEX-400', 'Hello');

	t.is(callCount, 1, 'should not retry on ENOENT');
	t.false(result);
});
