import {test, expect, beforeEach, afterEach} from 'bun:test';
import {testTmuxState} from '../test/helpers/state.ts';
import {
	getActiveSpaceCount,
	calculateIdealListHeight,
	calculateLayout,
	setConfiguredListLines,
} from './tmux.ts';

// The repository's own configuration must not decide these heights.
beforeEach(() => {
	setConfiguredListLines(1);
});

afterEach(() => {
	setConfiguredListLines(undefined);
});

// ============================================================================
// getActiveSpaceCount uses the space registry (not tmux sessions)
// ============================================================================

test('returns 0 when registry is empty', () => {
	testTmuxState({spaces: []});
	expect(getActiveSpaceCount()).toBe(0);
});

test('returns count of registered spaces', () => {
	testTmuxState({spaces: ['STA-100', 'STA-200', 'STA-300']});
	expect(getActiveSpaceCount()).toBe(3);
});

test('returns 1 for a single registered space', () => {
	testTmuxState({spaces: ['STA-100']});
	expect(getActiveSpaceCount()).toBe(1);
});

test('returns the count after a space opens', async () => {
	const {daos} = testTmuxState({spaces: ['STA-100']});
	expect(getActiveSpaceCount()).toBe(1);
	await daos.registry.add('STA-200');
	expect(getActiveSpaceCount()).toBe(2);
});

// ============================================================================
// List-pane sizing accounts for the always-pinned main-worktree row that
// app.tsx prepends above the user's registered spaces. Without the +1
// adjustment the bottom row is clipped on narrow screens (the symptom
// reported by users with N>=1 worktrees).
// ============================================================================

function seedRegistry(spaces: string[]): void {
	testTmuxState({spaces});
}

test('calculateIdealListHeight: 0 registered spaces → height fits 1 row (main only)', () => {
	seedRegistry([]);
	// 0 registered + 1 main = 1 visible row → ideal height 1+2 = 3
	expect(calculateIdealListHeight()).toBe(3);
});

test('calculateIdealListHeight: 1 registered space → height fits 2 rows (main + 1)', () => {
	seedRegistry(['STA-100']);
	// 1 registered + 1 main = 2 visible rows → ideal height 2+2 = 4
	expect(calculateIdealListHeight()).toBe(4);
});

test('calculateIdealListHeight: 2 registered spaces → height fits 3 rows (main + 2)', () => {
	seedRegistry(['STA-100', 'STA-200']);
	// 2 registered + 1 main = 3 visible rows → ideal height 3+2 = 5
	// Without the main-worktree adjustment this returned 4 and clipped the
	// bottom row on narrow/mobile layouts — that was the bug.
	expect(calculateIdealListHeight()).toBe(5);
});

test('calculateIdealListHeight: 5 registered spaces → height fits 6 rows (main + 5)', () => {
	seedRegistry(['STA-1', 'STA-2', 'STA-3', 'STA-4', 'STA-5']);
	// 5 registered + 1 main = 6 visible rows → ideal height 6+2 = 8
	expect(calculateIdealListHeight()).toBe(8);
});

test('calculateLayout vertical: 2 registered spaces → list pane fits 3 rows on narrow screens', () => {
	seedRegistry(['STA-100', 'STA-200']);
	// Narrow screen (40 cols), 30 rows tall — typical mobile terminal.
	// 2 registered + 1 main = 3 visible rows → listHeight = 5 (3 + 2 chrome).
	// The 25% proportional cap allows up to floor(29 * 0.25) = 7 rows here,
	// so the ideal height drives the result.
	const layout = calculateLayout(40, 30);
	expect(layout.direction).toBe('vertical');
	expect(layout.listHeight).toBe(5);
});

test('calculateLayout vertical: 0 registered spaces → list pane still fits the main row', () => {
	seedRegistry([]);
	// 0 registered + 1 main = 1 visible row → listHeight = 3 (1 + 2 chrome)
	const layout = calculateLayout(40, 30);
	expect(layout.direction).toBe('vertical');
	expect(layout.listHeight).toBe(3);
});

test('calculateIdealListHeight: two-line rows take two terminal rows each', () => {
	seedRegistry(['STA-100', 'STA-200']);
	setConfiguredListLines(2);
	// 2 registered rows of 2 lines + the main row's 1 line → 4+1+2 = 7
	expect(calculateIdealListHeight()).toBe(7);
});
