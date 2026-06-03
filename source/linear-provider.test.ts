import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	LinearProvider,
	MAX_RETRIES,
	type CliExecutor,
	type LinearGraphQLClient,
	type SleepFn,
} from './providers/linear-provider.ts';
import type {TrackerIssue} from './providers/types.ts';
import {StateColorCache} from './providers/state-color-cache.ts';

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

// Generate a unique temp cache path for each test (avoids cross-test pollution
// and prevents tests from reading the real ~/.pappardelle/state-colors.json)
let tempCounter = 0;
function tempCachePath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

function tempCache(): StateColorCache {
	return new StateColorCache(tempCachePath());
}

// ============================================================================
// Existing pure-logic tests
// ============================================================================

test('LinearProvider has name "linear"', t => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	t.is(provider.name, 'linear');
});

test('getIssueCached returns null for uncached issues', t => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	t.is(provider.getIssueCached('STA-999'), null);
});

test('buildIssueUrl constructs Linear URL', t => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	t.is(
		provider.buildIssueUrl('STA-123'),
		'https://linear.app/stardust-labs/issue/STA-123',
	);
});

// ============================================================================
// getWorkflowStateColor: must be cache-only (no subprocess calls)
// LinearProvider.getWorkflowStateColor was previously shelling out to `linctl`
// synchronously. This caused React "setState during render" warnings because
// the subprocess failure triggered log.warn → error listener → setState in App.
// The fix: getWorkflowStateColor should only check the in-memory cache.
// ============================================================================

test('getWorkflowStateColor returns null for uncached state (no subprocess)', t => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	// This should return null immediately without shelling out to linctl.
	// If it shelled out, it would throw/hang in CI where linctl isn't installed.
	const color = provider.getWorkflowStateColor('In Progress');
	t.is(color, null);
});

test('getWorkflowStateColor returns null for "Done" when not cached', t => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	const color = provider.getWorkflowStateColor('Done');
	t.is(color, null);
});

test('clearCache does not throw', t => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	t.notThrows(() => provider.clearCache());
});

// ============================================================================
// getIssue: retry logic
// ============================================================================

test('getIssue succeeds on first attempt — no retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return makeIssueJson('STA-100', 'First try');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-100');

	t.is(callCount, 1);
	t.truthy(issue);
	t.is(issue!.title, 'First try');
	t.is(issue!.identifier, 'STA-100');
});

test('getIssue fails once then succeeds on retry', async t => {
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

	t.is(callCount, 2);
	t.truthy(issue);
	t.is(issue!.title, 'Retry success');
});

test('getIssue fails all retries — returns null and caches null', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw new Error('Network unreachable');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-300');

	t.is(callCount, MAX_RETRIES);
	t.is(issue, null);
	t.is(provider.getIssueCached('STA-300'), null);
});

test('getIssue with ENOENT — fails immediately, no retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-400');

	t.is(callCount, 1, 'should not retry on ENOENT');
	t.is(issue, null);
});

test('getIssue with ENOENT — subsequent calls return cached without CLI call', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-410');
	t.is(callCount, 1);

	// Second call should not invoke exec at all
	const issue2 = await provider.getIssue('STA-420');
	t.is(callCount, 1, 'linctlMissing should prevent further calls');
	t.is(issue2, null);
});

test('getIssue sleep is called between retries, not after final attempt', async t => {
	const sleepCalls: number[] = [];
	const sleepSpy: SleepFn = async (ms: number) => {
		sleepCalls.push(ms);
	};

	const exec: CliExecutor = async () => {
		throw new Error('Timeout');
	};

	const provider = new LinearProvider(exec, sleepSpy, tempCache());
	await provider.getIssue('STA-500');

	t.is(
		sleepCalls.length,
		MAX_RETRIES - 1,
		'sleep should be called between retries only',
	);
	for (const ms of sleepCalls) {
		t.is(ms, 500, 'sleep delay should be RETRY_DELAY_MS');
	}
});

test('getIssue populates workflow state color cache', async t => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-600', 'Color test', 'In Progress', '#4b9fea');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-600');

	t.is(provider.getWorkflowStateColor('In Progress'), '#4b9fea');
});

test('getIssue returns cached result within TTL without calling CLI', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return makeIssueJson('STA-700', 'Cached');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-700');
	t.is(callCount, 1);

	// Second call should use cache
	const issue2 = await provider.getIssue('STA-700');
	t.is(callCount, 1, 'should not call CLI again within TTL');
	t.truthy(issue2);
	t.is(issue2!.title, 'Cached');
});

// ============================================================================
// stateColorMap refresh: getIssue() vs getIssueCached()
// Regression tests for STA-589 — getIssue() must be called on every poll
// so that stateColorMap stays populated (used for main worktree color).
// ============================================================================

test('getIssue refreshes stateColorMap from cache hit within TTL', async t => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-800', 'Color refresh', 'In Progress', '#4b9fea');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-800');
	t.is(provider.getWorkflowStateColor('In Progress'), '#4b9fea');

	// Calling getIssue again (cache hit) should still keep stateColorMap populated
	await provider.getIssue('STA-800');
	t.is(
		provider.getWorkflowStateColor('In Progress'),
		'#4b9fea',
		'stateColorMap should persist across cache-hit getIssue calls',
	);
});

test('getIssueCached does NOT populate stateColorMap', async t => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-810', 'Cache only', 'Done', '#27b067');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	await provider.getIssue('STA-810');

	// Clear internal stateColorMap by creating a fresh provider and copying the cache
	// Instead, verify the asymmetry: getIssueCached returns the issue but
	// calling getWorkflowStateColor for a *different* state not yet seen returns null
	t.is(provider.getWorkflowStateColor('Backlog'), null);
	t.truthy(provider.getIssueCached('STA-810'));
	// After getIssueCached, 'Backlog' is still not in stateColorMap
	t.is(
		provider.getWorkflowStateColor('Backlog'),
		null,
		'getIssueCached should not populate stateColorMap with new states',
	);
});

// ============================================================================
// createComment: retry logic
// ============================================================================

test('createComment succeeds on first attempt', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		return '';
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.createComment('STA-100', 'Hello');

	t.is(callCount, 1);
	t.true(result);
});

test('createComment fails once then succeeds on retry', async t => {
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

	t.is(callCount, 2);
	t.true(result);
});

test('createComment fails all retries — returns false', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw new Error('Network error');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.createComment('STA-300', 'Hello');

	t.is(callCount, MAX_RETRIES);
	t.false(result);
});

test('createComment with ENOENT — fails immediately, no retry', async t => {
	let callCount = 0;
	const exec: CliExecutor = async () => {
		callCount++;
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.createComment('STA-400', 'Hello');

	t.is(callCount, 1, 'should not retry on ENOENT');
	t.false(result);
});

// ============================================================================
// State color disk persistence (STA-590)
// The stateColorMap is persisted to ~/.pappardelle/state-colors.json so the
// main worktree color works even when no active issue has "Done" state.
// ============================================================================

test('getIssue persists state colors to disk', async t => {
	const cachePath = tempCachePath();
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-900', 'Persist test', 'In Progress', '#f2c94c');

	const provider = new LinearProvider(
		exec,
		noopSleep,
		new StateColorCache(cachePath),
	);
	await provider.getIssue('STA-900');

	// Verify file was written
	t.true(fs.existsSync(cachePath), 'state-colors.json should be created');
	const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
	t.is(data['In Progress'], '#f2c94c');
});

test('new provider loads persisted state colors from disk', async t => {
	const cachePath = tempCachePath();

	// Seed the cache file with state colors
	fs.writeFileSync(
		cachePath,
		JSON.stringify({Done: '#74d09f', 'In Progress': '#f2c94c'}) + '\n',
	);

	// New provider should load colors from disk immediately
	const provider = new LinearProvider(
		undefined,
		undefined,
		new StateColorCache(cachePath),
	);
	t.is(
		provider.getWorkflowStateColor('Done'),
		'#74d09f',
		'Done color should be loaded from persisted cache',
	);
	t.is(
		provider.getWorkflowStateColor('In Progress'),
		'#f2c94c',
		'In Progress color should be loaded from persisted cache',
	);
});

test('persisted colors survive across provider instances', async t => {
	const cachePath = tempCachePath();
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-910', 'Cross-instance', 'Done', '#74d09f');

	// First provider fetches an issue with "Done" state
	const provider1 = new LinearProvider(
		exec,
		noopSleep,
		new StateColorCache(cachePath),
	);
	await provider1.getIssue('STA-910');
	t.is(provider1.getWorkflowStateColor('Done'), '#74d09f');

	// Second provider (fresh instance, no issue fetches) should still have the color
	const provider2 = new LinearProvider(
		undefined,
		undefined,
		new StateColorCache(cachePath),
	);
	t.is(
		provider2.getWorkflowStateColor('Done'),
		'#74d09f',
		'Done color should persist across provider instances',
	);
});

test('state color update overwrites previous persisted value', async t => {
	const cachePath = tempCachePath();

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
		new StateColorCache(cachePath),
	);
	// Verify old color was loaded
	t.is(provider.getWorkflowStateColor('In Progress'), '#old0000');

	// Fetch issue with updated color
	await provider.getIssue('STA-920');
	t.is(provider.getWorkflowStateColor('In Progress'), '#new1111');

	// Verify disk was updated
	const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
	t.is(data['In Progress'], '#new1111');
});

test('persisted cache with invalid JSON is silently ignored', t => {
	const cachePath = tempCachePath();
	fs.writeFileSync(cachePath, 'not valid json!!!');

	// Should not throw — just start with empty map
	const provider = new LinearProvider(
		undefined,
		undefined,
		new StateColorCache(cachePath),
	);
	t.is(provider.getWorkflowStateColor('Done'), null);
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

test('getIssues returns empty map for empty keys array', async t => {
	const provider = new LinearProvider(undefined, undefined, tempCache());
	const result = await provider.getIssues([]);
	t.is(result.size, 0);
});

test('getIssues without GraphQL client returns null for every uncached key (no CLI)', async t => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-X', 'should not be called');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.getIssues(['STA-1', 'STA-2', 'STA-3']);

	t.is(cliCallCount, 0, 'getIssues must never shell out to linctl');
	t.is(result.size, 3);
	t.is(result.get('STA-1'), null);
	t.is(result.get('STA-2'), null);
	t.is(result.get('STA-3'), null);
});

test('getIssues without GraphQL client still serves cache-fresh keys', async t => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-90', 'Cached via getIssue', 'Done', '#74d09f');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	// Prime the cache via the singular path (which is still CLI-backed).
	await provider.getIssue('STA-90');
	t.is(cliCallCount, 1);

	const result = await provider.getIssues(['STA-90', 'STA-91']);
	t.is(cliCallCount, 1, 'getIssues must not call CLI even for the miss');
	t.is(result.get('STA-90')!.title, 'Cached via getIssue');
	t.is(result.get('STA-91'), null);
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

test('searchAssignedIssues calls linctl with --assignee and --state flags', async t => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return makeIssueListJson([
			{identifier: 'STA-10', title: 'Issue 10', stateName: 'To Do'},
		]);
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', ['To Do']);

	t.is(calls.length, 1);
	t.deepEqual(calls[0], [
		'issue',
		'list',
		'--assignee',
		'me',
		'--state',
		'To Do',
		'--json',
	]);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'STA-10');
});

test('searchAssignedIssues omits --assignee flag when assignee is undefined', async t => {
	const calls: string[][] = [];
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		return makeIssueListJson([
			{identifier: 'STA-10', title: 'Issue 10', stateName: 'To Do'},
		]);
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues(undefined, ['To Do']);

	t.is(calls.length, 1);
	t.deepEqual(calls[0], ['issue', 'list', '--state', 'To Do', '--json']);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'STA-10');
});

test('searchAssignedIssues makes one call per status', async t => {
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

	t.is(calls.length, 2);
	t.is(result.length, 2);
	t.truthy(result.find(i => i.identifier === 'STA-1'));
	t.truthy(result.find(i => i.identifier === 'STA-2'));
});

test('searchAssignedIssues deduplicates issues across statuses', async t => {
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
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'STA-1');
});

test('searchAssignedIssues returns empty array when linctlMissing', async t => {
	const exec: CliExecutor = async () => {
		throw makeEnoentError();
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	// Trigger linctlMissing
	await provider.getIssue('STA-99');

	const result = await provider.searchAssignedIssues('me', ['To Do']);
	t.deepEqual(result, []);
});

test('searchAssignedIssues returns empty array on CLI error', async t => {
	const exec: CliExecutor = async (_cmd, args) => {
		if (args[0] === 'issue' && args[1] === 'list') {
			throw new Error('API error');
		}

		return makeIssueJson('STA-1', 'Test');
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', ['To Do']);
	t.deepEqual(result, []);
});

test('searchAssignedIssues handles non-array JSON response (e.g. linctl "No issues found")', async t => {
	const exec: CliExecutor = async () =>
		JSON.stringify({info: 'No issues found'});

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', ['To Do']);
	t.deepEqual(result, []);
});

test('searchAssignedIssues returns empty array for empty statuses', async t => {
	const exec: CliExecutor = async () => makeIssueListJson([]);

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const result = await provider.searchAssignedIssues('me', []);
	t.deepEqual(result, []);
});

// ============================================================================
// Label parsing
// ============================================================================

test('getIssue parses labels from labels.nodes', async t => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-100', 'Labels test', 'In Progress', '#f2c94c', [
			'pappardelle',
			'platform',
		]);

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-100');

	t.truthy(issue);
	t.deepEqual(issue!.labels, ['pappardelle', 'platform']);
});

test('getIssue returns empty labels for issue with no labels', async t => {
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-100', 'No labels', 'In Progress', '#f2c94c');

	const provider = new LinearProvider(exec, noopSleep, tempCache());
	const issue = await provider.getIssue('STA-100');

	t.truthy(issue);
	t.deepEqual(issue!.labels, []);
});

test('searchAssignedIssues parses labels from list results', async t => {
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

	t.is(result.length, 2);
	t.deepEqual(result[0]!.labels, ['pappardelle', 'urgent']);
	t.deepEqual(result[1]!.labels, []);
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

test('getIssues uses GraphQL client when provided — one batched call, no CLI', async t => {
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

	t.is(graphqlCallCount, 1, 'GraphQL client should be called exactly once');
	t.is(cliCallCount, 0, 'CLI should not be called when GraphQL succeeds');
	t.deepEqual(receivedKeys, ['STA-1', 'STA-2', 'STA-3']);
	t.is(result.size, 3);
	t.is(result.get('STA-1')!.title, 'Issue STA-1');
	t.is(result.get('STA-3')!.title, 'Issue STA-3');
});

test('getIssues returns null for every key when GraphQL client returns null (no CLI)', async t => {
	let cliCallCount = 0;
	const exec: CliExecutor = async () => {
		cliCallCount++;
		return makeIssueJson('STA-X', 'must not be called');
	};

	const graphql: LinearGraphQLClient = async () => null;

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	const result = await provider.getIssues(['STA-1', 'STA-2']);

	t.is(cliCallCount, 0, 'getIssues must never shell out');
	t.is(result.size, 2);
	t.is(result.get('STA-1'), null);
	t.is(result.get('STA-2'), null);
});

test('getIssues leaves partial-response gaps as null (no per-key CLI rescue)', async t => {
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

	t.is(cliCallCount, 0, 'getIssues must never shell out');
	t.is(result.size, 3);
	t.is(result.get('STA-1')!.title, 'GQL-STA-1');
	t.is(result.get('STA-2'), null);
	t.is(result.get('STA-3'), null);
});

test('getIssues returns null for every key when GraphQL client throws (no CLI)', async t => {
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

	t.is(cliCallCount, 0, 'thrown GraphQL errors must not trigger CLI fan-out');
	t.is(result.size, 2);
	t.is(result.get('STA-1'), null);
	t.is(result.get('STA-2'), null);
});

test('getIssues GraphQL path populates cache and stateColors', async t => {
	const exec: CliExecutor = async () => {
		t.fail('CLI should not be called');
		return '';
	};

	const graphql: LinearGraphQLClient = async keys => {
		const map = new Map<string, TrackerIssue | null>();
		for (const k of keys) map.set(k, fakeIssue(k, 'GQL', 'Done', '#74d09f'));
		return map;
	};

	const provider = new LinearProvider(exec, noopSleep, tempCache(), graphql);
	await provider.getIssues(['STA-50']);

	t.is(provider.getIssueCached('STA-50')!.title, 'GQL');
	t.is(provider.getWorkflowStateColor('Done'), '#74d09f');
});

test('getIssues GraphQL path respects per-key TTL cache', async t => {
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

	t.is(
		graphqlCalls,
		2,
		'GraphQL called once per getIssues invocation (TTL not yet exceeded)',
	);
	// Second batch should skip STA-2 (cached, fresh) and only ask for STA-3
	t.deepEqual(seenKeys[1], ['STA-3']);
});

test('getIssues GraphQL path skips entirely when all keys are cache-fresh', async t => {
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

	t.is(graphqlCalls, 1, 'second call should be served entirely from cache');
});

test('persistence does not write when color unchanged', async t => {
	const cachePath = tempCachePath();
	const exec: CliExecutor = async () =>
		makeIssueJson('STA-930', 'No-op', 'In Progress', '#f2c94c');

	const provider = new LinearProvider(
		exec,
		noopSleep,
		new StateColorCache(cachePath),
	);
	await provider.getIssue('STA-930');

	// Record file mtime
	const stat1 = fs.statSync(cachePath);

	// Fetch same issue again (cache hit, same color) — should not rewrite
	await provider.getIssue('STA-930');
	const stat2 = fs.statSync(cachePath);

	t.is(
		stat1.mtimeMs,
		stat2.mtimeMs,
		'file should not be rewritten when color is unchanged',
	);
});
