import fs from 'node:fs';
import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
import {testState} from '../test/helpers/state.ts';
import {
	LinearProvider,
	MAX_RETRIES,
	type CliExecutor,
	type LinearGraphQLClient,
	type SleepFn,
} from './providers/linear-provider.ts';
import type {TrackerIssue} from './providers/types.ts';
import {
	StateColorCache,
	getStateColorsPath,
} from './providers/state-color-cache.ts';

// ============================================================================
// Helper: build a fake issue JSON string
// ============================================================================

function makeIssueJson(
	identifier = 'STA-100',
	title = 'Test issue',
	stateName = 'In Progress',
	stateColor = '#f2c94c',
	labels?: string[],
): string {
	return JSON.stringify({
		identifier,
		title,
		state: {name: stateName, type: 'started', color: stateColor},
		project: null,
		labels: {
			nodes: (labels ?? []).map(name => ({name})),
		},
	});
}

function makeEnoentError(): Error & {code: string} {
	const err = new Error('spawn linctl ENOENT') as Error & {code: string};
	err.code = 'ENOENT';
	return err;
}

// No-op sleep so tests don't wait
const noopSleep: SleepFn = async () => {};

/** A cache that keeps colors for the test only, never the real ~/.pappardelle. */
function tempCache(): StateColorCache {
	return new StateColorCache();
}

/** A color store on a temp directory, and the file it keeps. */
function colorStore() {
	const {daos, stateDir} = testState();
	return {
		dao: daos.stateColors,
		cachePath: getStateColorsPath('repo', stateDir),
	};
}

// ============================================================================
// Existing pure-logic tests
// ============================================================================

test('LinearProvider has name "linear"', () => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	expect(provider.name).toBe('linear');
});

test('getIssueCached returns null for uncached issues', () => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	expect(provider.getIssueCached('STA-999')).toBe(null);
});

test('buildIssueUrl falls back to hardcoded slug when cache is empty', () => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	expect(provider.buildIssueUrl('STA-123')).toBe(
		'https://linear.app/stardust-labs/issue/STA-123',
	);
});

test('buildIssueUrl prefers cached issue.url so cross-workspace issues open correctly', async () => {
	// Real failure mode the fallback alone can't catch: a WAB-* issue (in the
	// wabo-ventures workspace) was being advertised as linear.app/stardust-labs/
	// because buildIssueUrl ignored the API-provided URL on the cached issue.
	const fetchOnce: CliExecutor = async () =>
		JSON.stringify({
			identifier: 'WAB-10',
			title: 'Cross-workspace issue',
			state: {name: 'In Progress', type: 'started', color: '#f2c94c'},
			project: null,
			labels: {nodes: []},
			url: 'https://linear.app/wabo-ventures/issue/WAB-10/cross-workspace-issue',
		});

	const provider = new LinearProvider(fetchOnce, noopSleep, tempCache());
	const issue = await provider.getIssue('WAB-10');
	expect(issue).toBeTruthy();
	expect(provider.buildIssueUrl('WAB-10')).toBe(
		'https://linear.app/wabo-ventures/issue/WAB-10/cross-workspace-issue',
	);
});

// ============================================================================
// getWorkflowStateColor: must be cache-only (no subprocess calls)
// LinearProvider.getWorkflowStateColor was previously shelling out to `linctl`
// synchronously. This caused React "setState during render" warnings because
// the subprocess failure triggered log.warn → error listener → setState in App.
// The fix: getWorkflowStateColor should only check the in-memory cache.
// ============================================================================

test('getWorkflowStateColor returns null for uncached state (no subprocess)', () => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	// This should return null immediately without shelling out to linctl.
	// If it shelled out, it would throw/hang in CI where linctl isn't installed.
	const color = provider.getWorkflowStateColor('In Progress');
	expect(color).toBe(null);
});

test('getWorkflowStateColor returns null for "Done" when not cached', () => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	const color = provider.getWorkflowStateColor('Done');
	expect(color).toBe(null);
});

test('clearCache does not throw', () => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	expect(() => provider.clearCache()).not.toThrow();
});

// ============================================================================
// getIssue: retry logic
// ============================================================================

test('getIssue succeeds on first attempt — no retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return makeIssueJson('STA-100', 'First try');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-100');

	expect(callCount).toBe(1);
	expect(issue).toBeTruthy();
	expect(issue!.title).toBe('First try');
	expect(issue!.identifier).toBe('STA-100');
});

test('getIssue fails once then succeeds on retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		if (callCount === 1) {
			throw new Error('Connection timed out');
		}

		return makeIssueJson('STA-200', 'Retry success');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-200');

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

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-300');

	expect(callCount).toBe(MAX_RETRIES);
	expect(issue).toBe(null);
	expect(provider.getIssueCached('STA-300')).toBe(null);
});

test('getIssue with ENOENT — fails immediately, no retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-400');

	expect(callCount, 'should not retry on ENOENT').toBe(1);
	expect(issue).toBe(null);
});

test('getIssue with ENOENT — subsequent calls return cached without CLI call', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-410');
	expect(callCount).toBe(1);

	// Second call should not invoke exec at all
	const issue2 = await provider.getIssue('STA-420');
	expect(callCount, 'linctlMissing should prevent further calls').toBe(1);
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

	const provider = new LinearProvider(exec, sleepSpy, tempCache());
	await provider.getIssue('STA-500');

	expect(sleepCalls.length, 'sleep should be called between retries only').toBe(
		MAX_RETRIES - 1,
	);
	for (const ms of sleepCalls) {
		expect(ms, 'sleep delay should be RETRY_DELAY_MS').toBe(500);
	}
});

test('getIssue populates workflow state color cache', async () => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-600', 'Color test', 'In Progress', '#4b9fea');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-600');

	expect(provider.getWorkflowStateColor('In Progress')).toBe('#4b9fea');
});

test('getIssue returns cached result within TTL without calling CLI', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return makeIssueJson('STA-700', 'Cached');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-700');
	expect(callCount).toBe(1);

	// Second call should use cache
	const issue2 = await provider.getIssue('STA-700');
	expect(callCount, 'should not call CLI again within TTL').toBe(1);
	expect(issue2).toBeTruthy();
	expect(issue2!.title).toBe('Cached');
});

// ============================================================================
// stateColorMap refresh: getIssue() vs getIssueCached()
// Regression tests for STA-589 — getIssue() must be called on every poll
// so that stateColorMap stays populated (used for main worktree color).
// ============================================================================

test('getIssue refreshes stateColorMap from cache hit within TTL', async () => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-800', 'Color refresh', 'In Progress', '#4b9fea');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-800');
	expect(provider.getWorkflowStateColor('In Progress')).toBe('#4b9fea');

	// Calling getIssue again (cache hit) should still keep stateColorMap populated
	await provider.getIssue('STA-800');
	expect(
		provider.getWorkflowStateColor('In Progress'),
		'stateColorMap should persist across cache-hit getIssue calls',
	).toBe('#4b9fea');
});

test('getIssueCached does NOT populate stateColorMap', async () => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-810', 'Cache only', 'Done', '#27b067');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-810');

	// Clear internal stateColorMap by creating a fresh provider and copying the cache
	// Instead, verify the asymmetry: getIssueCached returns the issue but
	// calling getWorkflowStateColor for a *different* state not yet seen returns null
	expect(provider.getWorkflowStateColor('Backlog')).toBe(null);
	expect(provider.getIssueCached('STA-810')).toBeTruthy();
	// After getIssueCached, 'Backlog' is still not in stateColorMap
	expect(
		provider.getWorkflowStateColor('Backlog'),
		'getIssueCached should not populate stateColorMap with new states',
	).toBe(null);
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

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.createComment('STA-100', 'Hello');

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

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.createComment('STA-200', 'Hello');

	expect(callCount).toBe(2);
	expect(result).toBe(true);
});

test('createComment fails all retries — returns false', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw new Error('Network error');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.createComment('STA-300', 'Hello');

	expect(callCount).toBe(MAX_RETRIES);
	expect(result).toBe(false);
});

test('createComment with ENOENT — fails immediately, no retry', async () => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.createComment('STA-400', 'Hello');

	expect(callCount, 'should not retry on ENOENT').toBe(1);
	expect(result).toBe(false);
});

// ============================================================================
// State color disk persistence (STA-590)
// The stateColorMap is persisted to ~/.pappardelle/state-colors.json so the
// main worktree color works even when no active issue has "Done" state.
// ============================================================================

test('getIssue persists state colors to disk', async () => {
	const {dao, cachePath} = colorStore();
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-900', 'Persist test', 'In Progress', '#f2c94c');

	const provider = new LinearProvider(
		exec,
		noopSleep,
		new StateColorCache(dao),
	);
	await provider.getIssue('STA-900');

	// Verify file was written
	expect(fs.existsSync(cachePath), 'state-colors.json should be created').toBe(
		true,
	);
	const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
	expect(data['In Progress']).toBe('#f2c94c');
});

test('new provider loads persisted state colors from disk', () => {
	const {dao, cachePath} = colorStore();

	// Seed the cache file with state colors
	fs.writeFileSync(
		cachePath,
		JSON.stringify({Done: '#74d09f', 'In Progress': '#f2c94c'}) + '\n',
	);

	// New provider should load colors from disk immediately
	const provider = new LinearProvider(
		undefined,
		undefined,
		new StateColorCache(dao),
	);
	expect(
		provider.getWorkflowStateColor('Done'),
		'Done color should be loaded from persisted cache',
	).toBe('#74d09f');
	expect(
		provider.getWorkflowStateColor('In Progress'),
		'In Progress color should be loaded from persisted cache',
	).toBe('#f2c94c');
});

test('persisted colors survive across provider instances', async () => {
	const {dao} = colorStore();
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-910', 'Cross-instance', 'Done', '#74d09f');

	// First provider fetches an issue with "Done" state
	const provider1 = new LinearProvider(
		exec,
		noopSleep,
		new StateColorCache(dao),
	);
	await provider1.getIssue('STA-910');
	expect(provider1.getWorkflowStateColor('Done')).toBe('#74d09f');

	// Second provider (fresh instance, no issue fetches) should still have the color
	const provider2 = new LinearProvider(
		undefined,
		undefined,
		new StateColorCache(dao),
	);
	expect(
		provider2.getWorkflowStateColor('Done'),
		'Done color should persist across provider instances',
	).toBe('#74d09f');
});

test('state color update overwrites previous persisted value', async () => {
	const {dao, cachePath} = colorStore();

	// Seed with old color
	fs.writeFileSync(
		cachePath,
		JSON.stringify({'In Progress': '#old0000'}) + '\n',
	);

	const exec: CliExecutor = async () =>
		makeIssueJson('STA-920', 'Color update', 'In Progress', '#new1111');

	const provider = new LinearProvider(
		exec,
		noopSleep,
		new StateColorCache(dao),
	);
	// Verify old color was loaded
	expect(provider.getWorkflowStateColor('In Progress')).toBe('#old0000');

	// Fetch issue with updated color
	await provider.getIssue('STA-920');
	expect(provider.getWorkflowStateColor('In Progress')).toBe('#new1111');

	// Verify disk was updated
	const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
	expect(data['In Progress']).toBe('#new1111');
});

test('persisted cache with invalid JSON is silently ignored', () => {
	const {dao, cachePath} = colorStore();
	fs.writeFileSync(cachePath, 'not valid json!!!');

	// Should not throw — just start with empty map
	const provider = new LinearProvider(
		undefined,
		undefined,
		new StateColorCache(dao),
	);
	expect(provider.getWorkflowStateColor('Done')).toBe(null);
});

// ============================================================================
// getIssues: GraphQL-only bulk fetching (STA-1377)
//
// Per-workspace CLI fan-out is intentionally NOT a fallback — see the doc in
// LinearProvider.getIssues. Without a wired GraphQL client (or when the
// client returns null), uncached keys resolve to null. The provider never
// shells out to linctl from inside getIssues; only the singular `getIssue()`
// path keeps a CLI implementation.
// ============================================================================

test('getIssues returns empty map for empty keys array', async () => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	const result = await provider.getIssues([]);
	expect(result.size).toBe(0);
});

test('getIssues without GraphQL client returns null for every uncached key (no CLI)', async () => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-X', 'should not be called');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.getIssues(['STA-1', 'STA-2', 'STA-3']);

	expect(cliCallCount, 'getIssues must never shell out to linctl').toBe(0);
	expect(result.size).toBe(3);
	expect(result.get('STA-1')).toBe(null);
	expect(result.get('STA-2')).toBe(null);
	expect(result.get('STA-3')).toBe(null);
});

test('getIssues without GraphQL client still serves cache-fresh keys', async () => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-90', 'Cached via getIssue', 'Done', '#74d09f');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	// Prime the cache via the singular path (which is still CLI-backed).
	await provider.getIssue('STA-90');
	expect(cliCallCount).toBe(1);

	const result = await provider.getIssues(['STA-90', 'STA-91']);
	expect(cliCallCount, 'getIssues must not call CLI even for the miss').toBe(1);
	expect(result.get('STA-90')!.title).toBe('Cached via getIssue');
	expect(result.get('STA-91')).toBe(null);
});

// ============================================================================
// searchAssignedIssues
// ============================================================================

function makeIssueListJson(
	issues: Array<{
		identifier: string;
		title: string;
		stateName: string;
		stateColor?: string;
		labels?: string[];
	}>,
): string {
	return JSON.stringify(
		issues.map(i => ({
			identifier: i.identifier,
			title: i.title,
			state: {
				name: i.stateName,
				type: 'started',
				color: i.stateColor ?? '#f2c94c',
			},
			project: null,
			labels: {
				nodes: (i.labels ?? []).map(name => ({name})),
			},
		})),
	);
}

test('searchAssignedIssues calls linctl with --assignee and --state flags', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return makeIssueListJson([
			{identifier: 'STA-10', title: 'Issue 10', stateName: 'To Do'},
		]);
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', ['To Do']);

	expect(calls.length).toBe(1);
	expect(calls[0]).toStrictEqual([
		'issue',
		'list',
		'--assignee',
		'me',
		'--state',
		'To Do',
		'--json',
	]);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('STA-10');
});

test('searchAssignedIssues omits --assignee flag when assignee is undefined', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return makeIssueListJson([
			{identifier: 'STA-10', title: 'Issue 10', stateName: 'To Do'},
		]);
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues(undefined, ['To Do']);

	expect(calls.length).toBe(1);
	expect(calls[0]).toStrictEqual([
		'issue',
		'list',
		'--state',
		'To Do',
		'--json',
	]);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('STA-10');
});

test('searchAssignedIssues keeps a string createdAt and drops anything else', async () => {
	const exec: CliExecutor = async () =>
		JSON.stringify([
			{
				identifier: 'STA-10',
				title: 'Dated',
				state: {name: 'To Do', type: 'unstarted', color: '#fff'},
				createdAt: '2026-09-01T12:00:00.000Z',
			},
			{
				identifier: 'STA-11',
				title: 'Bad date',
				state: {name: 'To Do', type: 'unstarted', color: '#fff'},
				createdAt: 12_345,
			},
		]);

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues(undefined, ['To Do']);

	expect(result[0]!.createdAt).toBe('2026-09-01T12:00:00.000Z');
	expect(result[1]!.createdAt).toBe(undefined);
});

test('searchAssignedIssues makes one call per status', async () => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		const state = args[5];
		if (state === 'To Do') {
			return makeIssueListJson([
				{identifier: 'STA-1', title: 'Todo', stateName: 'To Do'},
			]);
		}

		return makeIssueListJson([
			{
				identifier: 'STA-2',
				title: 'In Progress',
				stateName: 'In Progress',
			},
		]);
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('charlie', [
		'To Do',
		'In Progress',
	]);

	expect(calls.length).toBe(2);
	expect(result.length).toBe(2);
	expect(result.find(i => i.identifier === 'STA-1')).toBeTruthy();
	expect(result.find(i => i.identifier === 'STA-2')).toBeTruthy();
});

test('searchAssignedIssues deduplicates issues across statuses', async () => {
	const exec: CliExecutor = async () =>
		makeIssueListJson([
			{identifier: 'STA-1', title: 'Shared', stateName: 'To Do'},
		]);

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', [
		'To Do',
		'In Progress',
	]);

	// STA-1 appears in both status calls, but should appear only once
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('STA-1');
});

test('searchAssignedIssues returns empty array when linctlMissing', async () => {
	const exec: CliExecutor = async () => {
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	// Trigger linctlMissing
	await provider.getIssue('STA-99');

	const result = await provider.searchAssignedIssues('me', ['To Do']);
	expect(result).toStrictEqual([]);
});

test('searchAssignedIssues returns empty array on CLI error', async () => {
	const exec: CliExecutor = async (_cmd, args) => {
		if (args[0] === 'issue' && args[1] === 'list') {
			throw new Error('API error');
		}

		return makeIssueJson('STA-1', 'Test');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', ['To Do']);
	expect(result).toStrictEqual([]);
});

test('searchAssignedIssues handles non-array JSON response (e.g. linctl "No issues found")', async () => {
	const exec: CliExecutor = async () =>
		JSON.stringify({info: 'No issues found'});

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', ['To Do']);
	expect(result).toStrictEqual([]);
});

test('searchAssignedIssues returns empty array for empty statuses', async () => {
	const exec: CliExecutor = async () => makeIssueListJson([]);

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', []);
	expect(result).toStrictEqual([]);
});

// ============================================================================
// Label parsing
// ============================================================================

test('getIssue parses labels from labels.nodes', async () => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-100', 'Labels test', 'In Progress', '#f2c94c', [
			'pappardelle',
			'platform',
		]);

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-100');

	expect(issue).toBeTruthy();
	expect(issue!.labels).toStrictEqual(['pappardelle', 'platform']);
});

test('getIssue returns empty labels for issue with no labels', async () => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-100', 'No labels', 'In Progress', '#f2c94c');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-100');

	expect(issue).toBeTruthy();
	expect(issue!.labels).toStrictEqual([]);
});

test('searchAssignedIssues parses labels from list results', async () => {
	const exec: CliExecutor = async () =>
		JSON.stringify([
			{
				identifier: 'STA-10',
				title: 'Issue 10',
				state: {name: 'To Do', type: 'unstarted', color: '#95a2b3'},
				project: null,
				labels: {nodes: [{name: 'pappardelle'}, {name: 'urgent'}]},
			},
			{
				identifier: 'STA-20',
				title: 'Issue 20',
				state: {name: 'To Do', type: 'unstarted', color: '#95a2b3'},
				project: null,
				labels: {nodes: []},
			},
		]);

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', ['To Do']);

	expect(result.length).toBe(2);
	expect(result[0]!.labels).toStrictEqual(['pappardelle', 'urgent']);
	expect(result[1]!.labels).toStrictEqual([]);
});

// ============================================================================
// getIssues: bulk GraphQL path (STA-1377)
//
// When a LinearGraphQLClient is wired in, getIssues should resolve every key
// from one batched request instead of N concurrent linctl subprocesses. The
// CLI path stays as a fallback for: missing GraphQL client (e.g. CI without
// the auth file), client returning null (network/auth failure), and any
// individual aliased issue resolving to null in the response.
// ============================================================================

function fakeIssue(
	identifier: string,
	title = `Issue ${identifier}`,
	stateName = 'In Progress',
	stateColor = '#f2c94c',
): TrackerIssue {
	return {
		identifier,
		title,
		state: {name: stateName, type: 'started', color: stateColor},
		project: null,
		labels: [],
	};
}

test('getIssues uses GraphQL client when provided — one batched call, no CLI', async () => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-1', 'CLI fallback');
	};

	let graphqlCallCount = 0;
	let receivedKeys: string[] | null = null;
	const graphql: LinearGraphQLClient = async keys => {
		graphqlCallCount++;
		receivedKeys = [...keys];
		const map = new Map<string, TrackerIssue | null>();
		for (const k of keys) map.set(k, fakeIssue(k));
		return map;
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	const result = await provider.getIssues(['STA-1', 'STA-2', 'STA-3']);

	expect(graphqlCallCount, 'GraphQL client should be called exactly once').toBe(
		1,
	);
	expect(cliCallCount, 'CLI should not be called when GraphQL succeeds').toBe(
		0,
	);
	expect(receivedKeys).toStrictEqual(['STA-1', 'STA-2', 'STA-3']);
	expect(result.size).toBe(3);
	expect(result.get('STA-1')!.title).toBe('Issue STA-1');
	expect(result.get('STA-3')!.title).toBe('Issue STA-3');
});

test('getIssues returns null for every key when GraphQL client returns null (no CLI)', async () => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-X', 'must not be called');
	};

	const graphql: LinearGraphQLClient = async () => null;

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	const result = await provider.getIssues(['STA-1', 'STA-2']);

	expect(cliCallCount, 'getIssues must never shell out').toBe(0);
	expect(result.size).toBe(2);
	expect(result.get('STA-1')).toBe(null);
	expect(result.get('STA-2')).toBe(null);
});

test('getIssues leaves partial-response gaps as null (no per-key CLI rescue)', async () => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-X', 'must not be called');
	};

	const graphql: LinearGraphQLClient = async keys => {
		const map = new Map<string, TrackerIssue | null>();
		for (const k of keys) {
			// Only STA-1 resolved; STA-2 is missing entirely, STA-3 is explicitly null.
			if (k === 'STA-1') map.set(k, fakeIssue(k, `GQL-${k}`));
			else if (k === 'STA-3') map.set(k, null);
		}

		return map;
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	const result = await provider.getIssues(['STA-1', 'STA-2', 'STA-3']);

	expect(cliCallCount, 'getIssues must never shell out').toBe(0);
	expect(result.size).toBe(3);
	expect(result.get('STA-1')!.title).toBe('GQL-STA-1');
	expect(result.get('STA-2')).toBe(null);
	expect(result.get('STA-3')).toBe(null);
});

test('getIssues returns null for every key when GraphQL client throws (no CLI)', async () => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-X', 'must not be called');
	};

	const graphql: LinearGraphQLClient = async () => {
		throw new Error('Linear API 500');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	const result = await provider.getIssues(['STA-1', 'STA-2']);

	expect(
		cliCallCount,
		'thrown GraphQL errors must not trigger CLI fan-out',
	).toBe(0);
	expect(result.size).toBe(2);
	expect(result.get('STA-1')).toBe(null);
	expect(result.get('STA-2')).toBe(null);
});

test('getIssues GraphQL path populates cache and stateColors', async () => {
	const exec: CliExecutor = async () => {
		unreachable('CLI should not be called');
		return '';
	};

	const graphql: LinearGraphQLClient = async keys => {
		const map = new Map<string, TrackerIssue | null>();
		for (const k of keys) map.set(k, fakeIssue(k, 'GQL', 'Done', '#74d09f'));
		return map;
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	await provider.getIssues(['STA-50']);

	expect(provider.getIssueCached('STA-50')!.title).toBe('GQL');
	expect(provider.getWorkflowStateColor('Done')).toBe('#74d09f');
});

test('getIssues GraphQL path respects per-key TTL cache', async () => {
	let graphqlCalls = 0;
	const seenKeys: string[][] = [];
	const exec: CliExecutor = async () => makeIssueJson('STA-X', 'noop');

	const graphql: LinearGraphQLClient = async keys => {
		graphqlCalls++;
		seenKeys.push([...keys]);
		const map = new Map<string, TrackerIssue | null>();
		for (const k of keys) map.set(k, fakeIssue(k));
		return map;
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	await provider.getIssues(['STA-1', 'STA-2']);
	await provider.getIssues(['STA-2', 'STA-3']);

	expect(
		graphqlCalls,
		'GraphQL called once per getIssues invocation (TTL not yet exceeded)',
	).toBe(2);
	// Second batch should skip STA-2 (cached, fresh) and only ask for STA-3
	expect(seenKeys[1]).toStrictEqual(['STA-3']);
});

test('getIssues GraphQL path skips entirely when all keys are cache-fresh', async () => {
	let graphqlCalls = 0;
	const exec: CliExecutor = async () => makeIssueJson('STA-X', 'noop');

	const graphql: LinearGraphQLClient = async keys => {
		graphqlCalls++;
		const map = new Map<string, TrackerIssue | null>();
		for (const k of keys) map.set(k, fakeIssue(k));
		return map;
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	await provider.getIssues(['STA-1', 'STA-2']);
	await provider.getIssues(['STA-1', 'STA-2']);

	expect(graphqlCalls, 'second call should be served entirely from cache').toBe(
		1,
	);
});

test('persistence does not write when color unchanged', async () => {
	const {dao, cachePath} = colorStore();
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-930', 'No-op', 'In Progress', '#f2c94c');

	const provider = new LinearProvider(
		exec,
		noopSleep,
		new StateColorCache(dao),
	);
	await provider.getIssue('STA-930');

	// Record file mtime
	const stat1 = fs.statSync(cachePath);

	// Fetch same issue again (cache hit, same color) — should not rewrite
	await provider.getIssue('STA-930');
	const stat2 = fs.statSync(cachePath);

	expect(
		stat1.mtimeMs,
		'file should not be rewritten when color is unchanged',
	).toBe(stat2.mtimeMs);
});
