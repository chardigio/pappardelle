import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	LinearProvider,
	MAX_RETRIES,
	type CliExecutor,
	type SleepFn,
} from './providers/linear-provider.ts';
import {StateColorCache} from './providers/state-color-cache.ts';

// ============================================================================
// Helper: build a fake issue JSON string
// ============================================================================

function makeIssueJson(
	identifier = 'STA-100',
	title = 'Test issue',
	stateName = 'In Progress',
	stateColor = '#f2c94c',
): string {
	return JSON.stringify({
		identifier,
		title,
		state: {name: stateName, type: 'started', color: stateColor},
		project: null,
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
