import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import {
	JiraProvider,
	MAX_RETRIES,
	mapJiraIssue,
	type CliExecutor,
	type SleepFn,
} from './providers/jira-provider.ts';
import {StateColorCache} from './providers/state-color-cache.ts';

function makeEnoentError(): Error & {code: string} {
	const err = new Error('spawn acli ENOENT') as Error & {code: string};
	err.code = 'ENOENT';
	return err;
}

// No-op sleep so tests don't wait
const noopSleep: SleepFn = async () => {};

/** A cache that keeps colors for the test only, never the real ~/.pappardelle. */
function tempCache(): StateColorCache {
	return new StateColorCache();
}

/** A color store on a temp directory. */
function colorStore() {
	const {daos} = testState();
	return {dao: daos.stateColors};
}

// ============================================================================
// mapJiraIssue — pure parsing logic
// ============================================================================

test('mapJiraIssue extracts title from standard Jira response', () => {
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
	expect(issue.identifier).toBe('CHEX-300');
	expect(issue.title).toBe('Refactor OrderService for PRISM accept flow');
	expect(issue.state.name).toBe('Done');
	expect(issue.state.color).toBe('#4caf50');
});

test('mapJiraIssue handles missing project field', () => {
	const raw = {
		key: 'CHEX-123',
		fields: {
			summary: 'Fix bug',
			status: {name: 'In Progress', statusCategory: {name: 'In Progress'}},
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.title).toBe('Fix bug');
	expect(issue.project).toBe(null);
});

test('mapJiraIssue carries the Jira project key alongside its name', () => {
	// STA-1649: profile resolution matches tracker_projects against the Jira
	// project key as well as its name, so both must survive the mapping.
	const raw = {
		key: 'KAN-9',
		fields: {
			summary: 'Task',
			status: {name: 'To Do', statusCategory: {name: 'To Do'}},
			project: {key: 'KAN', name: 'Pappardelle Testing'},
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.project).toStrictEqual({
		name: 'Pappardelle Testing',
		key: 'KAN',
	});
});

test('mapJiraIssue leaves project key undefined when the response lacks it', () => {
	const raw = {
		key: 'KAN-9',
		fields: {
			summary: 'Task',
			status: {name: 'To Do', statusCategory: {name: 'To Do'}},
			project: {name: 'Pappardelle Testing'},
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.project?.name).toBe('Pappardelle Testing');
	expect(issue.project?.key).toBe(undefined);
});

test('mapJiraIssue maps statusCategory to color', () => {
	const raw = {
		key: 'CHEX-1',
		fields: {
			summary: 'Task',
			status: {name: 'To Do', statusCategory: {name: 'To Do'}},
		},
	};
	expect(mapJiraIssue(raw).state.color).toBe('#95a2b3');
});

// ============================================================================
// mapJiraIssue — label parsing
// ============================================================================

test('mapJiraIssue extracts labels from fields.labels', () => {
	const raw = {
		key: 'CHEX-400',
		fields: {
			summary: 'Labeled issue',
			status: {name: 'To Do', statusCategory: {name: 'To Do'}},
			labels: ['pappardelle', 'platform'],
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.labels).toStrictEqual(['pappardelle', 'platform']);
});

test('mapJiraIssue returns undefined labels when fields.labels is missing', () => {
	const raw = {
		key: 'CHEX-401',
		fields: {
			summary: 'No labels',
			status: {name: 'In Progress', statusCategory: {name: 'In Progress'}},
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.labels).toBe(undefined);
});

test('mapJiraIssue filters out non-string entries from fields.labels', () => {
	const raw = {
		key: 'CHEX-402',
		fields: {
			summary: 'Mixed labels',
			status: {name: 'Done', statusCategory: {name: 'Done'}},
			labels: ['valid', 123, null, 'also-valid', true],
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.labels).toStrictEqual(['valid', 'also-valid']);
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

test('getIssue populates cache and getIssueCached returns issue', async () => {
	const json = makeJiraResponse('CHEX-100', 'Add feature X');
	const provider = new JiraProvider(
		'https://example.com',
		async () => json,
		undefined,
		tempCache(),
	);

	const issue = await provider.getIssue('CHEX-100');
	expect(issue).toBeTruthy();
	expect(issue!.title).toBe('Add feature X');

	const cached = provider.getIssueCached('CHEX-100');
	expect(cached).toBeTruthy();
	expect(cached!.title).toBe('Add feature X');
});

test('getIssue extracts issue when CLI exits non-zero but stdout has valid JSON', async () => {
	// acli returns valid JSON but exits with code 1 — execFile rejects
	const json = makeJiraResponse('CHEX-200', 'Fix authentication bug');
	const provider = new JiraProvider(
		'https://example.com',
		async () => {
			const err = new Error('Command failed: exit code 1') as Error & {
				stdout: string;
				status: number;
			};
			err.stdout = json;
			err.status = 1;
			throw err;
		},
		undefined,
		tempCache(),
	);

	const issue = await provider.getIssue('CHEX-200');
	expect(issue, 'should extract issue from error.stdout').toBeTruthy();
	expect(issue!.title).toBe('Fix authentication bug');

	const cached = provider.getIssueCached('CHEX-200');
	expect(cached, 'cache should have the issue').toBeTruthy();
	expect(cached!.title).toBe('Fix authentication bug');
});

test('getIssue returns null when CLI truly fails (no stdout)', async () => {
	const provider = new JiraProvider(
		'https://example.com',
		async () => {
			throw new Error('Connection refused');
		},
		noopSleep,
		tempCache(),
	);

	const issue = await provider.getIssue('CHEX-999');
	expect(issue).toBe(null);
	expect(provider.getIssueCached('CHEX-999')).toBe(null);
});

// ============================================================================
// Existing unit tests
// ============================================================================

test('JiraProvider has name "jira"', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	expect(provider.name).toBe('jira');
});

test('buildIssueUrl uses base_url', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	expect(provider.buildIssueUrl('PROJ-123')).toBe(
		'https://mycompany.atlassian.net/browse/PROJ-123',
	);
});

test('buildIssueUrl strips trailing slash from base_url', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net/',
		undefined,
		undefined,
		tempCache(),
	);
	expect(provider.buildIssueUrl('PROJ-456')).toBe(
		'https://mycompany.atlassian.net/browse/PROJ-456',
	);
});

test('getIssueCached returns null for uncached issues', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	expect(provider.getIssueCached('PROJ-999')).toBe(null);
});

test('getWorkflowStateColor returns null for unknown state', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	expect(provider.getWorkflowStateColor('Unknown State')).toBe(null);
});

// ============================================================================
// getWorkflowStateColor: static fallback for known Jira status categories
// Before any issues are fetched, the color cache is empty. But for well-known
// Jira status categories ("To Do", "In Progress", "Done"), the provider should
// return its static STATUS_CATEGORY_COLORS so the main worktree row can be
// colored correctly without needing to fetch an issue first.
// ============================================================================

test('getWorkflowStateColor returns blue for "In Progress" without any fetched issues', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	const color = provider.getWorkflowStateColor('In Progress');
	expect(color).toBe('#4b9fea');
});

test('getWorkflowStateColor returns green for "Done" without any fetched issues', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	const color = provider.getWorkflowStateColor('Done');
	expect(color).toBe('#4caf50');
});

test('getWorkflowStateColor returns gray for "To Do" without any fetched issues', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	const color = provider.getWorkflowStateColor('To Do');
	expect(color).toBe('#95a2b3');
});

test('clearCache does not throw', () => {
	const provider = new JiraProvider(
		'https://mycompany.atlassian.net',
		undefined,
		undefined,
		tempCache(),
	);
	expect(() => provider.clearCache()).not.toThrow();
});

// ============================================================================
// getIssue: retry logic
// ============================================================================

test('getIssue succeeds on first attempt — no retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return makeJiraResponse('CHEX-100', 'First try');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const issue = await provider.getIssue('CHEX-100');

	expect(callCount).toBe(1);
	expect(issue).toBeTruthy();
	expect(issue!.title).toBe('First try');
	expect(issue!.identifier).toBe('CHEX-100');
});

test('getIssue fails once then succeeds on retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		if (callCount === 1) {
			throw new Error('Connection timed out');
		}

		return makeJiraResponse('CHEX-200', 'Retry success');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const issue = await provider.getIssue('CHEX-200');

	expect(callCount).toBe(2);
	expect(issue).toBeTruthy();
	expect(issue!.title).toBe('Retry success');
});

test('getIssue fails all retries — returns null and caches null', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw new Error('Network unreachable');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const issue = await provider.getIssue('CHEX-300');

	expect(callCount).toBe(MAX_RETRIES);
	expect(issue).toBe(null);
	expect(provider.getIssueCached('CHEX-300')).toBe(null);
});

test('getIssue with ENOENT — fails immediately, no retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const issue = await provider.getIssue('CHEX-400');

	expect(callCount, 'should not retry on ENOENT').toBe(1);
	expect(issue).toBe(null);
});

test('getIssue with ENOENT — subsequent calls return cached without CLI call', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	await provider.getIssue('CHEX-410');
	expect(callCount).toBe(1);

	// Second call should not invoke exec at all
	const issue2 = await provider.getIssue('CHEX-420');
	expect(callCount, 'acliMissing should prevent further calls').toBe(1);
	expect(issue2).toBe(null);
});

test('getIssue sleep is called between retries, not after final attempt', async () => {
	const sleepCalls: number[] = [];
	const sleepSpy: SleepFn = async (ms: number) => {
		sleepCalls.push(ms);
	};

	const exec: CliExecutor = async () => {
		throw new Error('Timeout');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		sleepSpy,
		tempCache(),
	);
	await provider.getIssue('CHEX-500');

	expect(sleepCalls.length, 'sleep should be called between retries only').toBe(
		MAX_RETRIES - 1,
	);
	for (const ms of sleepCalls) {
		expect(ms, 'sleep delay should be RETRY_DELAY_MS').toBe(500);
	}
});

test('getIssue extracts issue from non-zero exit stdout without retrying', async () => {
	let callCount = 0;
	const json = makeJiraResponse('CHEX-600', 'Stdout extraction');
	const exec: CliExecutor = async () => {
		callCount++;
		const err = new Error('Command failed: exit code 1') as Error & {
			stdout: string;
			status: number;
		};
		err.stdout = json;
		err.status = 1;
		throw err;
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const issue = await provider.getIssue('CHEX-600');

	expect(callCount, 'should not retry when stdout has valid JSON').toBe(1);
	expect(issue).toBeTruthy();
	expect(issue!.title).toBe('Stdout extraction');
});

test('getIssue returns cached result within TTL without calling CLI', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return makeJiraResponse('CHEX-700', 'Cached');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	await provider.getIssue('CHEX-700');
	expect(callCount).toBe(1);

	// Second call should use cache
	const issue2 = await provider.getIssue('CHEX-700');
	expect(callCount, 'should not call CLI again within TTL').toBe(1);
	expect(issue2).toBeTruthy();
	expect(issue2!.title).toBe('Cached');
});

// ============================================================================
// createComment: retry logic
// ============================================================================

test('createComment succeeds on first attempt', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return '';
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.createComment('CHEX-100', 'Hello');

	expect(callCount).toBe(1);
	expect(result).toBe(true);
});

test('createComment fails once then succeeds on retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		if (callCount === 1) {
			throw new Error('Timeout');
		}

		return '';
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.createComment('CHEX-200', 'Hello');

	expect(callCount).toBe(2);
	expect(result).toBe(true);
});

test('createComment fails all retries — returns false', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw new Error('Network error');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.createComment('CHEX-300', 'Hello');

	expect(callCount).toBe(MAX_RETRIES);
	expect(result).toBe(false);
});

test('createComment with ENOENT — fails immediately, no retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.createComment('CHEX-400', 'Hello');

	expect(callCount, 'should not retry on ENOENT').toBe(1);
	expect(result).toBe(false);
});

// ============================================================================
// State color disk persistence (STA-590)
// ============================================================================

test('getIssue stores the state colors it reads', async () => {
	const {dao} = colorStore();
	const exec: CliExecutor = async () =>
		makeJiraResponse('CHEX-800', 'Persist test', 'In Progress', 'In Progress');

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		new StateColorCache(dao),
	);
	await provider.getIssue('CHEX-800');

	expect(dao.load()).toEqual({'In Progress': '#4b9fea'});
});

// ============================================================================
// getIssues: batch fetching (STA-608)
// ============================================================================

test('getIssues returns empty map for empty keys array', async () => {
	const provider = new JiraProvider(
		'https://example.com',
		async () => '[]',
		noopSleep,
		tempCache(),
	);
	const result = await provider.getIssues([]);
	expect(result.size).toBe(0);
});

test('getIssues fetches multiple issues via single JQL search', async () => {
	let callCount = 0;
	let lastArgs: string[] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		callCount++;
		lastArgs = args;
		return JSON.stringify([
			{
				key: 'CHEX-1',
				fields: {
					summary: 'First',
					status: {name: 'Done', statusCategory: {name: 'Done'}},
				},
			},
			{
				key: 'CHEX-2',
				fields: {
					summary: 'Second',
					status: {
						name: 'In Progress',
						statusCategory: {name: 'In Progress'},
					},
				},
			},
		]);
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.getIssues(['CHEX-1', 'CHEX-2']);

	expect(callCount, 'should make a single CLI call').toBe(1);
	expect(lastArgs.includes('--jql'), 'should use JQL search').toBe(true);
	expect(result.size).toBe(2);
	expect(result.get('CHEX-1')!.title).toBe('First');
	expect(result.get('CHEX-2')!.title).toBe('Second');
});

test('getIssues populates cache and stateColors', async () => {
	const exec: CliExecutor = async () =>
		JSON.stringify([
			{
				key: 'CHEX-10',
				fields: {
					summary: 'Cache test',
					status: {name: 'Done', statusCategory: {name: 'Done'}},
				},
			},
		]);

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	await provider.getIssues(['CHEX-10']);

	expect(provider.getIssueCached('CHEX-10')!.title).toBe('Cache test');
	expect(provider.getWorkflowStateColor('Done')).toBe('#4caf50');
});

test('getIssues caches null for keys not found in results', async () => {
	const exec: CliExecutor = async (_cmd, args) => {
		if (args.includes('search')) {
			return JSON.stringify([
				{
					key: 'CHEX-20',
					fields: {
						summary: 'Found',
						status: {name: 'Done', statusCategory: {name: 'Done'}},
					},
				},
			]);
		}

		// Unmatched keys fall back to an individual `view`. A genuinely-missing
		// key fails with no stdout, so getIssue() resolves it to null.
		throw new Error('Issue does not exist');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.getIssues(['CHEX-20', 'CHEX-21']);

	expect(result.get('CHEX-20')).toBeTruthy();
	expect(result.get('CHEX-21')).toBe(null);
	expect(provider.getIssueCached('CHEX-21')).toBe(null);
});

// ============================================================================
// Moved issues (CHAZ-22)
//
// When a Jira issue is moved between projects (e.g. CHAZ-7 → FXAI-54), acli
// transparently follows the move: `view CHAZ-7` and `search "key in (CHAZ-7)"`
// both return the *destination* issue, keyed by its new identifier (FXAI-54).
// Pappardelle tracks worktrees by their original key, so we alias the moved
// issue's data back to the requested key.
// ============================================================================

test('getIssue aliases a moved issue back to the requested key', async () => {
	// `view CHAZ-7` follows the move, returning the destination keyed FXAI-54.
	const json = makeJiraResponse('FXAI-54', 'Moved issue title');
	const provider = new JiraProvider(
		'https://example.com',
		async () => json,
		noopSleep,
		tempCache(),
	);

	const issue = await provider.getIssue('CHAZ-7');
	expect(issue).toBeTruthy();
	expect(
		issue!.identifier,
		'identifier should be aliased to the requested key',
	).toBe('CHAZ-7');
	expect(issue!.title).toBe('Moved issue title');
	expect(
		provider.getIssueCached('CHAZ-7')!.identifier,
		'cache should be keyed and aliased to the requested key',
	).toBe('CHAZ-7');
});

test('getIssue aliases a moved issue from non-zero exit stdout', async () => {
	// `view --json` on a moved issue prints valid JSON to stdout but exits 1.
	const json = makeJiraResponse('FXAI-54', 'Moved via stderr exit');
	const provider = new JiraProvider(
		'https://example.com',
		async () => {
			const err = new Error('Command failed: exit code 1') as Error & {
				stdout: string;
				status: number;
			};
			err.stdout = json;
			err.status = 1;
			throw err;
		},
		noopSleep,
		tempCache(),
	);

	const issue = await provider.getIssue('CHAZ-7');
	expect(issue).toBeTruthy();
	expect(issue!.identifier).toBe('CHAZ-7');
	expect(issue!.title).toBe('Moved via stderr exit');
});

test('getIssues resolves a moved issue back to the requested key', async () => {
	const exec: CliExecutor = async (_cmd, args) => {
		if (args.includes('search')) {
			// JQL `key in (CHAZ-7)` follows the move → destination key FXAI-54.
			return JSON.stringify([
				{
					key: 'FXAI-54',
					fields: {
						summary: 'Moved batch issue',
						status: {
							name: 'In Review',
							statusCategory: {name: 'In Progress'},
						},
					},
				},
			]);
		}

		// Per-key `view` fallback for the unmatched requested key.
		return makeJiraResponse(
			'FXAI-54',
			'Moved batch issue',
			'In Review',
			'In Progress',
		);
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.getIssues(['CHAZ-7']);

	const issue = result.get('CHAZ-7');
	expect(
		issue,
		'moved issue should resolve under the requested key',
	).toBeTruthy();
	expect(issue!.identifier).toBe('CHAZ-7');
	expect(issue!.title).toBe('Moved batch issue');
	expect(
		result.get('FXAI-54'),
		'should not pollute results with the destination key',
	).toBe(undefined);
});

test('getIssues resolves mixed direct and moved issues', async () => {
	const exec: CliExecutor = async (_cmd, args) => {
		if (args.includes('search')) {
			return JSON.stringify([
				{
					key: 'CHEX-1',
					fields: {
						summary: 'Direct',
						status: {name: 'Done', statusCategory: {name: 'Done'}},
					},
				},
				{
					key: 'FXAI-54',
					fields: {
						summary: 'Moved',
						status: {name: 'To Do', statusCategory: {name: 'To Do'}},
					},
				},
			]);
		}

		// `view` fallback for the unmatched requested key (CHAZ-7).
		return makeJiraResponse('FXAI-54', 'Moved');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.getIssues(['CHEX-1', 'CHAZ-7']);

	expect(result.get('CHEX-1')!.title).toBe('Direct');
	expect(result.get('CHEX-1')!.identifier).toBe('CHEX-1');
	expect(result.get('CHAZ-7')!.title).toBe('Moved');
	expect(result.get('CHAZ-7')!.identifier).toBe('CHAZ-7');
});

test('getIssues falls back to individual calls when search fails', async () => {
	let callCount = 0;
	const exec: CliExecutor = async (_cmd, args) => {
		callCount++;
		if (args.includes('search')) {
			throw new Error('Search command not supported');
		}

		// Individual view calls
		const key = args[3]!;
		return makeJiraResponse(key, `Issue ${key}`);
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.getIssues(['CHEX-30', 'CHEX-31']);

	expect(callCount > 1, 'should fall back to individual calls').toBe(true);
	expect(result.get('CHEX-30')!.title).toBe('Issue CHEX-30');
	expect(result.get('CHEX-31')!.title).toBe('Issue CHEX-31');
});

test('getIssues returns cached values when acliMissing', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	// Trigger acliMissing
	await provider.getIssue('CHEX-40');
	expect(callCount).toBe(1);

	// getIssues should not make any CLI calls
	const result = await provider.getIssues(['CHEX-40', 'CHEX-41']);
	expect(callCount, 'should not make CLI calls when acliMissing').toBe(1);
	expect(result.get('CHEX-40')).toBe(null);
	expect(result.get('CHEX-41')).toBe(null);
});

test('getIssues sets acliMissing on ENOENT during batch search', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.getIssues(['CHEX-50']);
	expect(callCount).toBe(1);
	expect(result.get('CHEX-50')).toBe(null);

	// Subsequent call should not invoke CLI
	const result2 = await provider.getIssues(['CHEX-51']);
	expect(callCount, 'acliMissing should prevent further calls').toBe(1);
	expect(result2.get('CHEX-51')).toBe(null);
});

// ============================================================================
// searchAssignedIssues
// ============================================================================

test('searchAssignedIssues calls acli with JQL for assignee and statuses', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return JSON.stringify([
			{
				key: 'CHEX-100',
				fields: {
					summary: 'My todo',
					status: {name: 'To Do', statusCategory: {name: 'To Do'}},
				},
			},
		]);
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.searchAssignedIssues('me', [
		'To Do',
		'In Progress',
	]);

	expect(calls.length).toBe(1);
	expect(calls[0]!.includes('--jql')).toBe(true);
	const jqlIndex = calls[0]!.indexOf('--jql');
	const jql = calls[0]![jqlIndex + 1]!;
	expect(jql.includes('assignee')).toBe(true);
	expect(jql.includes('currentUser()')).toBe(true);
	expect(jql.includes('To Do')).toBe(true);
	expect(jql.includes('In Progress')).toBe(true);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('CHEX-100');
});

test('searchAssignedIssues uses currentUser() for "me" in JQL', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return '[]';
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	await provider.searchAssignedIssues('me', ['To Do']);

	const jql = calls[0]![calls[0]!.indexOf('--jql') + 1]!;
	expect(
		jql.includes('currentUser()'),
		'should use currentUser() for "me" assignee',
	).toBe(true);
});

test('searchAssignedIssues omits assignee clause when assignee is undefined', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return '[]';
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	await provider.searchAssignedIssues(undefined, ['To Do', 'In Progress']);

	const jql = calls[0]![calls[0]!.indexOf('--jql') + 1]!;
	expect(
		jql.includes('assignee'),
		'should not include assignee clause when undefined',
	).toBe(false);
	expect(jql.includes('status IN'), 'should still include status clause').toBe(
		true,
	);
});

test('searchAssignedIssues uses quoted assignee for explicit usernames', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return '[]';
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	await provider.searchAssignedIssues('charlie@example.com', ['To Do']);

	const jql = calls[0]![calls[0]!.indexOf('--jql') + 1]!;
	expect(
		jql.includes('"charlie@example.com"'),
		'should quote explicit assignee',
	).toBe(true);
});

for (const assignee of ['me', undefined]) {
	test(`searchAssignedIssues orders by creation date (assignee: ${String(assignee)})`, async () => {
		const calls: string[][] = [];
		const exec: CliExecutor = async (_cmd, args) => {
			calls.push(args);
			return '[]';
		};

		const provider = new JiraProvider(
			'https://example.com',
			exec,
			noopSleep,
			tempCache(),
		);
		await provider.searchAssignedIssues(assignee, ['To Do']);

		const jql = calls[0]![calls[0]!.indexOf('--jql') + 1]!;
		expect(
			jql.endsWith(' ORDER BY created DESC'),
			`unexpected JQL: ${jql}`,
		).toBe(true);
	});
}

test('searchAssignedIssues returns the newest-first page oldest first', async () => {
	const exec: CliExecutor = async () =>
		JSON.stringify(
			['STE-30', 'STE-20', 'STE-10'].map(key => ({
				key,
				fields: {
					summary: key,
					status: {name: 'To Do', statusCategory: {key: 'new'}},
				},
			})),
		);

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.searchAssignedIssues('me', ['To Do']);

	expect(result.map(issue => issue.identifier)).toStrictEqual([
		'STE-10',
		'STE-20',
		'STE-30',
	]);
});

test('searchAssignedIssues returns empty array when acliMissing', async () => {
	const exec: CliExecutor = async () => {
		throw makeEnoentError();
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	// Trigger acliMissing
	await provider.getIssue('CHEX-1');

	const result = await provider.searchAssignedIssues('me', ['To Do']);
	expect(result).toStrictEqual([]);
});

test('searchAssignedIssues returns empty array for empty statuses', async () => {
	const exec: CliExecutor = async () => '[]';

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.searchAssignedIssues('me', []);
	expect(result).toStrictEqual([]);
});

test('searchAssignedIssues skips malformed issues without discarding valid ones', async () => {
	const exec: CliExecutor = async () => {
		return JSON.stringify([
			{
				key: 'CHEX-1',
				fields: {
					summary: 'Good issue',
					status: {name: 'To Do', statusCategory: {name: 'To Do'}},
				},
			},
			// Malformed: key is a number instead of string, which will cause mapJiraIssue
			// to set identifier to a non-string. We simulate a throw by using a getter.
			null,
			{
				key: 'CHEX-3',
				fields: {
					summary: 'Another good issue',
					status: {name: 'To Do', statusCategory: {name: 'To Do'}},
				},
			},
		]);
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.searchAssignedIssues('me', ['To Do']);

	// Should get both valid issues, skipping the null entry that causes mapJiraIssue to throw
	// (results come back reversed: acli returns newest first)
	expect(result.length).toBe(2);
	expect(result[0]!.identifier).toBe('CHEX-3');
	expect(result[1]!.identifier).toBe('CHEX-1');
});

test('searchAssignedIssues escapes double quotes in assignee', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return '[]';
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	await provider.searchAssignedIssues('user"name', ['To Do']);

	const jql = calls[0]![calls[0]!.indexOf('--jql') + 1]!;
	expect(
		jql.includes('assignee = "user\\"name"'),
		'should escape double quotes in assignee',
	).toBe(true);
});

test('searchAssignedIssues returns empty array on CLI error', async () => {
	const exec: CliExecutor = async (_cmd, args) => {
		if (args.includes('search')) {
			throw new Error('API error');
		}

		return makeJiraResponse('CHEX-1', 'Test');
	};

	const provider = new JiraProvider(
		'https://example.com',
		exec,
		noopSleep,
		tempCache(),
	);
	const result = await provider.searchAssignedIssues('me', ['To Do']);
	expect(result).toStrictEqual([]);
});

test('a new Jira provider starts with the stored state colors', async () => {
	const {dao} = colorStore();
	await dao.set('Done', '#custom00');
	await dao.set('In Progress', '#custom11');

	const provider = new JiraProvider(
		'https://example.com',
		undefined,
		undefined,
		new StateColorCache(dao),
	);
	// Persisted cache should take priority over STATUS_CATEGORY_COLORS
	expect(provider.getWorkflowStateColor('Done')).toBe('#custom00');
	expect(provider.getWorkflowStateColor('In Progress')).toBe('#custom11');
});

// ============================================================================
// mapJiraIssue — status category to state.type normalization (STA-2139)
// ============================================================================

test('mapJiraIssue normalizes the Done category to "completed"', () => {
	const raw = {
		key: 'CHEX-500',
		fields: {
			summary: 'Finished work',
			status: {
				name: 'Done',
				statusCategory: {key: 'done', name: 'Done'},
			},
		},
	};
	expect(mapJiraIssue(raw).state.type).toBe('completed');
});

test('mapJiraIssue normalizes the In Progress category to "started"', () => {
	const raw = {
		key: 'CHEX-501',
		fields: {
			summary: 'Ongoing work',
			status: {
				name: 'In Review',
				statusCategory: {key: 'indeterminate', name: 'In Progress'},
			},
		},
	};
	expect(mapJiraIssue(raw).state.type).toBe('started');
});

test('mapJiraIssue normalizes the To Do category to "unstarted"', () => {
	const raw = {
		key: 'CHEX-502',
		fields: {
			summary: 'Queued work',
			status: {
				name: 'To Do',
				statusCategory: {key: 'new', name: 'To Do'},
			},
		},
	};
	expect(mapJiraIssue(raw).state.type).toBe('unstarted');
});

test('mapJiraIssue normalizes by category name when the key is absent', () => {
	const raw = {
		key: 'CHEX-503',
		fields: {
			summary: 'Finished work, no category key',
			status: {name: 'Shipped', statusCategory: {name: 'Done'}},
		},
	};
	expect(mapJiraIssue(raw).state.type).toBe('completed');
});

test('mapJiraIssue prefers the category key over a localized category name', () => {
	const raw = {
		key: 'CHEX-504',
		fields: {
			summary: 'Terminé',
			status: {name: 'Terminé', statusCategory: {key: 'done', name: 'Terminé'}},
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.state.type).toBe('completed');
	expect(issue.state.color).toBe('#4caf50');
});

test('mapJiraIssue falls back to "unstarted" for an unknown category', () => {
	const raw = {
		key: 'CHEX-505',
		fields: {
			summary: 'Mystery category',
			status: {name: 'Weird', statusCategory: {name: 'Some Other Thing'}},
		},
	};
	const issue = mapJiraIssue(raw);
	expect(issue.state.type).toBe('unstarted');
	expect(issue.state.color).toBe('#95a2b3');
});

test('mapJiraIssue defaults to "unstarted" when status is missing', () => {
	const raw = {key: 'CHEX-506', fields: {summary: 'No status at all'}};
	expect(mapJiraIssue(raw).state.type).toBe('unstarted');
});
