import test from 'ava';
import {
	computePostDeleteState,
	filterSpaces,
	shouldAttachOnSelection,
	shouldShowLoadingTitle,
	tearDownSpace,
} from './space-utils.ts';
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
// computePostDeleteState
// ============================================================================

test('removes the deleted space from the list', t => {
	const spaces = [makeSpace('STA-1'), makeSpace('STA-2'), makeSpace('STA-3')];
	const {filteredSpaces} = computePostDeleteState(spaces, 'STA-2', 1);
	t.deepEqual(
		filteredSpaces.map(s => s.name),
		['STA-1', 'STA-3'],
	);
});

test('deleting the last item adjusts selectedIndex downward', t => {
	const spaces = [makeSpace('STA-1'), makeSpace('STA-2'), makeSpace('STA-3')];
	// Selected index 2 (last item) — after deletion only 2 items remain (indices 0-1)
	const {newSelectedIndex} = computePostDeleteState(spaces, 'STA-3', 2);
	t.is(newSelectedIndex, 1);
});

test('deleting a middle item does not change selectedIndex when it stays valid', t => {
	const spaces = [makeSpace('STA-1'), makeSpace('STA-2'), makeSpace('STA-3')];
	// Selected index 0 — deleting STA-2 leaves 2 items, index 0 is still valid
	const {newSelectedIndex} = computePostDeleteState(spaces, 'STA-2', 0);
	t.is(newSelectedIndex, 0);
});

test('deleting the only remaining item clamps to 0', t => {
	const spaces = [makeSpace('STA-1')];
	const {filteredSpaces, newSelectedIndex} = computePostDeleteState(
		spaces,
		'STA-1',
		0,
	);
	t.is(filteredSpaces.length, 0);
	t.is(newSelectedIndex, 0);
});

test('deleting a space that is not in the list is a no-op', t => {
	const spaces = [makeSpace('STA-1'), makeSpace('STA-2')];
	const {filteredSpaces, newSelectedIndex} = computePostDeleteState(
		spaces,
		'STA-999',
		1,
	);
	t.is(filteredSpaces.length, 2);
	t.is(newSelectedIndex, 1);
});

test('deleting the selected-last item with index > 0 decrements index', t => {
	// 4 items, selected index 3 (last). Deleting it leaves 3 items → index should be 2.
	const spaces = [
		makeSpace('STA-1'),
		makeSpace('STA-2'),
		makeSpace('STA-3'),
		makeSpace('STA-4'),
	];
	const {newSelectedIndex} = computePostDeleteState(spaces, 'STA-4', 3);
	t.is(newSelectedIndex, 2);
});

test('deleting from middle keeps selectedIndex when it is below deleted position', t => {
	const spaces = [makeSpace('STA-1'), makeSpace('STA-2'), makeSpace('STA-3')];
	// Selected index 2 (STA-3), delete STA-2 → 2 items remain, index 2 is out of bounds → clamp to 1
	const {newSelectedIndex} = computePostDeleteState(spaces, 'STA-2', 2);
	t.is(newSelectedIndex, 1);
});

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
// filterSpaces
// ============================================================================

test('filterSpaces: empty query returns all spaces with identity index map', t => {
	const spaces = [makeSpace('STA-1'), makeSpace('STA-2'), makeSpace('STA-3')];
	const {filtered, indexMap} = filterSpaces(spaces, '');
	t.is(filtered.length, 3);
	t.deepEqual(indexMap, [0, 1, 2]);
});

test('filterSpaces: matches by issue key (case-insensitive)', t => {
	const spaces = [
		makeSpace('STA-100'),
		makeSpace('STA-200'),
		makeSpace('STA-300'),
	];
	const {filtered, indexMap} = filterSpaces(spaces, 'sta-2');
	t.deepEqual(
		filtered.map(s => s.name),
		['STA-200'],
	);
	t.deepEqual(indexMap, [1]);
});

test('filterSpaces: matches by issue title (case-insensitive)', t => {
	const spaces = [
		makeSpace('STA-1', {
			linearIssue: {
				identifier: 'STA-1',
				title: 'Fix login bug',
				state: {name: 'Todo', color: '#ccc'},
			},
		}),
		makeSpace('STA-2', {
			linearIssue: {
				identifier: 'STA-2',
				title: 'Add search feature',
				state: {name: 'Todo', color: '#ccc'},
			},
		}),
		makeSpace('STA-3', {
			linearIssue: {
				identifier: 'STA-3',
				title: 'Refactor database',
				state: {name: 'Todo', color: '#ccc'},
			},
		}),
	];
	const {filtered, indexMap} = filterSpaces(spaces, 'search');
	t.deepEqual(
		filtered.map(s => s.name),
		['STA-2'],
	);
	t.deepEqual(indexMap, [1]);
});

test('filterSpaces: matches both name and title across multiple spaces', t => {
	const spaces = [
		makeSpace('STA-10', {
			linearIssue: {
				identifier: 'STA-10',
				title: 'Dashboard redesign',
				state: {name: 'Todo', color: '#ccc'},
			},
		}),
		makeSpace('STA-20', {
			linearIssue: {
				identifier: 'STA-20',
				title: 'Fix STA-10 regression',
				state: {name: 'Todo', color: '#ccc'},
			},
		}),
		makeSpace('STA-30'),
	];
	// "sta-10" matches STA-10 by name and STA-20 by title
	const {filtered, indexMap} = filterSpaces(spaces, 'sta-10');
	t.deepEqual(
		filtered.map(s => s.name),
		['STA-10', 'STA-20'],
	);
	t.deepEqual(indexMap, [0, 1]);
});

test('filterSpaces: no matches returns empty list', t => {
	const spaces = [makeSpace('STA-1'), makeSpace('STA-2')];
	const {filtered, indexMap} = filterSpaces(spaces, 'nonexistent');
	t.is(filtered.length, 0);
	t.deepEqual(indexMap, []);
});

test('filterSpaces: partial key match works', t => {
	const spaces = [
		makeSpace('STA-123'),
		makeSpace('STA-456'),
		makeSpace('STA-127'),
	];
	const {filtered} = filterSpaces(spaces, '12');
	t.deepEqual(
		filtered.map(s => s.name),
		['STA-123', 'STA-127'],
	);
});

test('filterSpaces: spaces without linearIssue only match on name', t => {
	const spaces = [
		makeSpace('STA-1'),
		makeSpace('STA-2', {
			linearIssue: {
				identifier: 'STA-2',
				title: 'Has a title',
				state: {name: 'Todo', color: '#ccc'},
			},
		}),
	];
	const {filtered} = filterSpaces(spaces, 'title');
	t.deepEqual(
		filtered.map(s => s.name),
		['STA-2'],
	);
});

test('filterSpaces: index map correctly maps back to original positions', t => {
	const spaces = [
		makeSpace('STA-1'),
		makeSpace('STA-2'),
		makeSpace('STA-3'),
		makeSpace('STA-4'),
		makeSpace('STA-5'),
	];
	const {filtered, indexMap} = filterSpaces(spaces, 'sta-3');
	t.deepEqual(
		filtered.map(s => s.name),
		['STA-3'],
	);
	t.deepEqual(indexMap, [2]);
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
		killSpaceSessions(key: string) {
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

test('tearDownSpace: kill succeeds → remove called, returns true', t => {
	const {deps, calls} = makeTearDownDeps(true);
	const ok = tearDownSpace('STA-100', deps);
	t.true(ok);
	t.deepEqual(calls.killed, ['STA-100']);
	t.deepEqual(calls.removed, ['STA-100']);
	t.deepEqual(calls.killFailures, []);
});

test('tearDownSpace: kill fails → remove NOT called, onKillFailure surfaced, returns false', t => {
	const {deps, calls} = makeTearDownDeps(false);
	const ok = tearDownSpace('STA-100', deps);
	t.false(ok);
	t.deepEqual(calls.killed, ['STA-100']);
	t.deepEqual(calls.removed, []);
	t.deepEqual(calls.killFailures, ['STA-100']);
});

test('tearDownSpace: kill runs BEFORE remove (order matters for STA-1420)', t => {
	// If remove ran first and kill then failed, the registry would advertise
	// "closed" while the inner socket still has the session — exactly the bug
	// STA-1420 fixes. Pin the order with a sequence tape.
	const sequence: string[] = [];
	const ok = tearDownSpace('STA-7', {
		killSpaceSessions() {
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

// ============================================================================
// shouldAttachOnSelection — STA-1553 teardown→respawn guard
// ============================================================================

test('attaches when selecting a different, non-closing space', t => {
	t.true(
		shouldAttachOnSelection({
			selectedSpaceName: 'STA-2',
			currentSpace: 'STA-1',
			closingSpaces: new Set(),
		}),
	);
});

test('does not re-attach to the space already being shown', t => {
	t.false(
		shouldAttachOnSelection({
			selectedSpaceName: 'STA-1',
			currentSpace: 'STA-1',
			closingSpaces: new Set(),
		}),
	);
});

// The race the guard exists for: closing the currently-viewed space nulls
// currentSpace in one render and prunes the list in the next. In that window the
// effect sees currentSpace=null with the just-closed space still selected; without
// the guard it would call attachToSpace, which recreates the inner sessions
// teardown just killed — stranding them for the next startup's reaper.
test('does NOT re-attach to a space whose teardown is in flight (currentSpace already null)', t => {
	t.false(
		shouldAttachOnSelection({
			selectedSpaceName: 'STA-1478',
			currentSpace: null,
			closingSpaces: new Set(['STA-1478']),
		}),
	);
});

test('still attaches to a normal space while an unrelated space is closing', t => {
	t.true(
		shouldAttachOnSelection({
			selectedSpaceName: 'STA-2',
			currentSpace: null,
			closingSpaces: new Set(['STA-1478']),
		}),
	);
});
