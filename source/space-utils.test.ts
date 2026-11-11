import test from 'ava';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {shouldShowLoadingTitle, tearDownSpace} from './space-utils.ts';
import type {SpaceData} from './types.ts';

// ============================================================================
// Test helpers
// ============================================================================

function makeSpace(name: string, opts?: Partial<SpaceData>): SpaceData {
	return {
		name,
		worktreePath: `/worktrees/${name}`,
		...opts,
	};
}

// ============================================================================
// shouldShowLoadingTitle
// ============================================================================

test('shows loading when linearIssue is undefined and space is not pending or main', t => {
	t.true(shouldShowLoadingTitle(makeSpace('STA-123')));
});

test('does not show loading for main worktree rows', t => {
	t.false(shouldShowLoadingTitle(makeSpace('main', {isMainWorktree: true})));
});

test('does not show loading when pendingTitle is set', t => {
	t.false(
		shouldShowLoadingTitle(
			makeSpace('STA-123', {pendingTitle: 'Starting new session…'}),
		),
	);
});

test('does not show loading when linearIssue title is available', t => {
	t.false(
		shouldShowLoadingTitle(
			makeSpace('STA-123', {
				linearIssue: {
					identifier: 'STA-123',
					title: 'Fix the bug',
					state: {name: 'In Progress', color: '#f2c94c'},
				},
			}),
		),
	);
});

test('does not show loading when name is empty', t => {
	t.false(shouldShowLoadingTitle(makeSpace('')));
});

// ============================================================================
// tearDownSpace
//
// Locks in STA-1420 Layer 1: the close path must kill tmux sessions BEFORE
// removing the space from the persisted registry. If the kill fails, the
// registry stays untouched so the user can retry — otherwise the registry
// silently advertises "closed" for a session still living on the inner socket
// (which post-STA-1416 has no `seedFromTmux` reaper to mop it up).
// ============================================================================

test('tearDownSpace waits for an asynchronous kill before unregistering', async t => {
	let finish = (_success: boolean) => {};
	const killed = new Promise<boolean>(resolve => {
		finish = resolve;
	});
	const removed: string[] = [];
	const result = tearDownSpace('A', {
		async killSpaceSessions() {
			return killed;
		},
		removeSpace(key) {
			removed.push(key);
		},
		onKillFailure() {
			t.fail('kill should succeed');
		},
	});
	await nextTurn();
	t.deepEqual(removed, []);
	finish(true);
	t.true(await result);
	t.deepEqual(removed, ['A']);
});

type TearDownCalls = {
	killed: string[];
	removed: string[];
	killFailures: string[];
};

function makeTearDownDeps(killReturns: boolean): {
	deps: Parameters<typeof tearDownSpace>[1];
	calls: TearDownCalls;
} {
	const calls: TearDownCalls = {killed: [], removed: [], killFailures: []};
	const deps = {
		async killSpaceSessions(key: string) {
			calls.killed.push(key);
			return killReturns;
		},
		removeSpace(key: string) {
			calls.removed.push(key);
		},
		onKillFailure(key: string) {
			calls.killFailures.push(key);
		},
	};
	return {deps, calls};
}

test('tearDownSpace: kill succeeds → remove called, returns true', async t => {
	const {deps, calls} = makeTearDownDeps(true);
	const ok = await tearDownSpace('STA-100', deps);
	t.true(ok);
	t.deepEqual(calls.killed, ['STA-100']);
	t.deepEqual(calls.removed, ['STA-100']);
	t.deepEqual(calls.killFailures, []);
});

test('tearDownSpace: kill fails → remove NOT called, onKillFailure surfaced, returns false', async t => {
	const {deps, calls} = makeTearDownDeps(false);
	const ok = await tearDownSpace('STA-100', deps);
	t.false(ok);
	t.deepEqual(calls.killed, ['STA-100']);
	t.deepEqual(calls.removed, []);
	t.deepEqual(calls.killFailures, ['STA-100']);
});

test('tearDownSpace: kill runs BEFORE remove (order matters for STA-1420)', async t => {
	// If remove ran first and kill then failed, the registry would advertise
	// "closed" while the inner socket still has the session — exactly the bug
	// STA-1420 fixes. Pin the order with a sequence tape.
	const sequence: string[] = [];
	const ok = await tearDownSpace('STA-7', {
		async killSpaceSessions() {
			sequence.push('kill');
			return true;
		},
		removeSpace() {
			sequence.push('remove');
		},
		onKillFailure() {
			sequence.push('failure');
		},
	});
	t.true(ok);
	t.deepEqual(sequence, ['kill', 'remove']);
});
