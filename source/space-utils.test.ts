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
		async markClosing() {},
		async reopen() {},
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
	t.deepEqual(await result, {outcome: 'closed'});
	t.deepEqual(removed, ['A']);
});

/** Teardown deps that record the order they were called in. */
function recordingDeps(
	fail: {mark?: Error; kill?: boolean; remove?: Error; reopen?: Error} = {},
) {
	const sequence: string[] = [];
	const deps: Parameters<typeof tearDownSpace>[1] = {
		async markClosing(key) {
			sequence.push(`mark ${key}`);
			if (fail.mark) throw fail.mark;
		},
		async reopen(key) {
			sequence.push(`reopen ${key}`);
			if (fail.reopen) throw fail.reopen;
		},
		async killSpaceSessions(key) {
			sequence.push(`kill ${key}`);
			return !fail.kill;
		},
		removeSpace(key) {
			sequence.push(`remove ${key}`);
			if (fail.remove) throw fail.remove;
		},
		onKillFailure(key) {
			sequence.push(`kill-failure ${key}`);
		},
		async cleanup(key) {
			sequence.push(`cleanup ${key}`);
			return true;
		},
	};
	return {deps, sequence};
}

test('tearDownSpace records the close, kills, then unregisters (order matters for STA-1420)', async t => {
	// If remove ran first and kill then failed, the registry would advertise
	// "closed" while the inner socket still has the session — exactly the bug
	// STA-1420 fixes.
	const {deps, sequence} = recordingDeps();
	t.deepEqual(await tearDownSpace('STA-7', deps), {outcome: 'closed'});
	t.deepEqual(sequence, [
		'mark STA-7',
		'kill STA-7',
		'remove STA-7',
		'cleanup STA-7',
	]);
});

test('tearDownSpace: a close that cannot be recorded kills nothing', async t => {
	const error = new Error('database is locked');
	const {deps, sequence} = recordingDeps({mark: error});
	t.deepEqual(await tearDownSpace('STA-100', deps), {
		outcome: 'mark-failed',
		error,
	});
	t.deepEqual(sequence, ['mark STA-100']);
});

test('tearDownSpace: a failed kill reopens the space and leaves it registered', async t => {
	const {deps, sequence} = recordingDeps({kill: true});
	t.deepEqual(await tearDownSpace('STA-100', deps), {outcome: 'kill-failed'});
	t.deepEqual(sequence, [
		'mark STA-100',
		'kill STA-100',
		'reopen STA-100',
		'kill-failure STA-100',
	]);
});

test('tearDownSpace: a failed kill is still reported when the reopen fails too', async t => {
	const {deps, sequence} = recordingDeps({
		kill: true,
		reopen: new Error('database is locked'),
	});
	t.deepEqual(await tearDownSpace('STA-100', deps), {outcome: 'kill-failed'});
	t.is(sequence.at(-1), 'kill-failure STA-100');
});

test('tearDownSpace: a failed removal is an outcome, with the sessions gone and nothing cleaned up', async t => {
	const error = new Error('database is locked');
	const {deps, sequence} = recordingDeps({remove: error});
	t.deepEqual(await tearDownSpace('STA-100', deps), {
		outcome: 'unregister-failed',
		error,
	});
	t.deepEqual(sequence, ['mark STA-100', 'kill STA-100', 'remove STA-100']);
});
