import test from 'ava';
import {computePostDeleteState} from './space-utils.ts';
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
