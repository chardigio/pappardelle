import test from 'ava';
import {
	calculateMaxVisibleItems,
	calculateScrollOffset,
	calculateVisibleWindow,
	calculateAvailableTitleWidth,
	truncateTitle,
	renderListRow,
	renderListView,
	LIST_CHROME_ROWS,
	ROW_FIXED_OVERHEAD,
} from './list-view-sizing.ts';

// ============================================================================
// Test helpers
// ============================================================================

/** Create N dummy items for testing. */
function makeItems(count: number) {
	return Array.from({length: count}, (_, i) => ({
		issueKey: `STA-${(400 + i).toString()}`,
		icon: '\u00b7', // ·
		title: `Issue title number ${i + 1}`,
	}));
}

/**
 * Render a complete list-view ASCII snapshot and compare it with expected.
 */
function assertListView(
	t: any,
	actual: string,
	expected: string,
	label: string,
) {
	const trimmedActual = actual.trim();
	const trimmedExpected = expected.trim();

	if (trimmedActual !== trimmedExpected) {
		t.log(`\n${label} - MISMATCH`);
		t.log('Expected:');
		t.log(trimmedExpected);
		t.log('\nActual:');
		t.log(trimmedActual);
	}

	t.is(trimmedActual, trimmedExpected, label);
}

// ============================================================================
// Constants Verification
// ============================================================================

test('constants: LIST_CHROME_ROWS = 2 (header only, no footer)', t => {
	t.is(LIST_CHROME_ROWS, 2);
});

test('constants: ROW_FIXED_OVERHEAD = 3 (icon + 2 spaces)', t => {
	t.is(ROW_FIXED_OVERHEAD, 3);
});

// ============================================================================
// calculateMaxVisibleItems
// ============================================================================

test('maxVisible: height 8, no status = 6 items', t => {
	// 8 - 2 (chrome) = 6
	t.is(calculateMaxVisibleItems(8), 6);
});

test('maxVisible: height 10, no status = 8 items', t => {
	t.is(calculateMaxVisibleItems(10), 8);
});

test('maxVisible: height 20, no status = 18 items', t => {
	t.is(calculateMaxVisibleItems(20), 18);
});

test('maxVisible: height 40, no status = 38 items', t => {
	t.is(calculateMaxVisibleItems(40), 38);
});

test('maxVisible: height 4, no status = 2 items', t => {
	// 4 - 2 = 2
	t.is(calculateMaxVisibleItems(4), 2);
});

test('maxVisible: height 3, no status = 1 item (minimum)', t => {
	// 3 - 2 = 1
	t.is(calculateMaxVisibleItems(3), 1);
});

test('maxVisible: height 1, no status = 1 item (minimum)', t => {
	t.is(calculateMaxVisibleItems(1), 1);
});

test('maxVisible: height 5, no status = 3 items', t => {
	// 5 - 2 = 3
	t.is(calculateMaxVisibleItems(5), 3);
});

test('maxVisible: height 6, no status = 4 items', t => {
	// 6 - 2 = 4
	t.is(calculateMaxVisibleItems(6), 4);
});

// ============================================================================
// calculateScrollOffset
// ============================================================================

test('scrollOffset: first item selected, no scroll', t => {
	t.is(calculateScrollOffset(0, 10, 5), 0);
});

test('scrollOffset: second item selected, no scroll', t => {
	t.is(calculateScrollOffset(1, 10, 5), 0);
});

test('scrollOffset: middle item selected, centred', t => {
	// selectedIndex=5, maxVisible=5 → 5 - floor(5/2) = 3
	t.is(calculateScrollOffset(5, 10, 5), 3);
});

test('scrollOffset: last item selected, clamped to end', t => {
	// selectedIndex=9, maxVisible=5 → min(9-2, 10-5) = min(7, 5) = 5
	t.is(calculateScrollOffset(9, 10, 5), 5);
});

test('scrollOffset: all items fit, always 0', t => {
	t.is(calculateScrollOffset(0, 3, 5), 0);
	t.is(calculateScrollOffset(1, 3, 5), 0);
	t.is(calculateScrollOffset(2, 3, 5), 0);
});

test('scrollOffset: items == maxVisible, always 0', t => {
	t.is(calculateScrollOffset(0, 5, 5), 0);
	t.is(calculateScrollOffset(2, 5, 5), 0);
	t.is(calculateScrollOffset(4, 5, 5), 0);
});

// ============================================================================
// calculateVisibleWindow
// ============================================================================

test('visibleWindow: 5 items, height 8, selected 0', t => {
	const w = calculateVisibleWindow(0, 5, 8);
	// maxVisible = 8-2 = 6, scrollOffset = 0, visibleCount = min(6,5) = 5
	t.is(w.scrollOffset, 0);
	t.is(w.visibleCount, 5);
	t.is(w.adjustedSelectedIndex, 0);
});

test('visibleWindow: 5 items, height 8, selected 4 (last)', t => {
	const w = calculateVisibleWindow(4, 5, 8);
	// maxVisible = 6, all 5 fit, scrollOffset = 0
	t.is(w.scrollOffset, 0);
	t.is(w.visibleCount, 5);
	t.is(w.adjustedSelectedIndex, 4);
});

test('visibleWindow: 10 items, height 8, selected 5 (middle)', t => {
	const w = calculateVisibleWindow(5, 10, 8);
	// maxVisible = 6, scrollOffset = min(5-3, 10-6) = min(2,4) = 2
	t.is(w.scrollOffset, 2);
	t.is(w.visibleCount, 6);
	t.is(w.adjustedSelectedIndex, 3); // 5 - 2
});

test('visibleWindow: 2 items, height 8, selected 0', t => {
	const w = calculateVisibleWindow(0, 2, 8);
	// maxVisible = 6, scrollOffset = 0, visibleCount = min(6,2) = 2
	t.is(w.scrollOffset, 0);
	t.is(w.visibleCount, 2);
	t.is(w.adjustedSelectedIndex, 0);
});

test('visibleWindow: 1 item, height 8', t => {
	const w = calculateVisibleWindow(0, 1, 8);
	t.is(w.scrollOffset, 0);
	t.is(w.visibleCount, 1);
	t.is(w.adjustedSelectedIndex, 0);
});

test('visibleWindow: 20 items, height 20, selected 10', t => {
	const w = calculateVisibleWindow(10, 20, 20);
	// maxVisible = 18, scrollOffset = min(10-9, 20-18) = min(1,2) = 1
	t.is(w.scrollOffset, 1);
	t.is(w.visibleCount, 18);
	t.is(w.adjustedSelectedIndex, 9); // 10 - 1
});

// ============================================================================
// Row Rendering: Title Width
//
// New format: "icon(1) space(1) issueKey(var) space(1) title"
// Fixed overhead = 3, total fixed = 3 + issueKey.length
// ============================================================================

test('titleWidth: width 40, key "STA-452" (7) \u2192 30 chars for title', t => {
	// 40 - 3 - 7 = 30
	t.is(calculateAvailableTitleWidth(40, 7), 30);
});

test('titleWidth: width 30, key "STA-452" (7) \u2192 20 chars for title', t => {
	t.is(calculateAvailableTitleWidth(30, 7), 20);
});

test('titleWidth: width 50, key "STA-452" (7) \u2192 40 chars for title', t => {
	t.is(calculateAvailableTitleWidth(50, 7), 40);
});

test('titleWidth: width 10, key "STA-452" (7) \u2192 0 chars (no room)', t => {
	// 10 - 3 - 7 = 0
	t.is(calculateAvailableTitleWidth(10, 7), 0);
});

test('titleWidth: width 8, key "STA-452" (7) \u2192 0 chars (clamped)', t => {
	t.is(calculateAvailableTitleWidth(8, 7), 0);
});

test('titleWidth: short key "STA-1" (5) gives more room', t => {
	// 40 - 3 - 5 = 32
	t.is(calculateAvailableTitleWidth(40, 5), 32);
});

test('titleWidth: long key "STA-9999" (8) gives less room', t => {
	// 40 - 3 - 8 = 29
	t.is(calculateAvailableTitleWidth(40, 8), 29);
});

// ============================================================================
// Row Rendering: Title Truncation
// ============================================================================

test('truncate: short title fits', t => {
	t.is(truncateTitle('Hello', 10), 'Hello');
});

test('truncate: exact fit', t => {
	t.is(truncateTitle('Hello', 5), 'Hello');
});

test('truncate: one char over \u2192 truncated with ellipsis', t => {
	t.is(truncateTitle('Hello!', 5), 'Hell\u2026');
});

test('truncate: long title', t => {
	t.is(
		truncateTitle('This is a very long issue title', 15),
		'This is a very\u2026',
	);
});

test('truncate: zero width \u2192 empty', t => {
	t.is(truncateTitle('Hello', 0), '');
});

// ============================================================================
// renderListRow
//
// New format: "icon space issueKey space title"
// No selector prefix, no padded issue key.
// ============================================================================

test('renderListRow: basic row', t => {
	const row = renderListRow('STA-452', '\u00b7', 'Fix the bug', 40);
	// available = 40 - 3 - 7 = 30, title fits
	t.is(row, '\u00b7 STA-452 Fix the bug');
});

test('renderListRow: different icon', t => {
	const row = renderListRow('STA-451', '?', 'Add feature', 40);
	t.is(row, '? STA-451 Add feature');
});

test('renderListRow: long title truncated', t => {
	const row = renderListRow(
		'STA-400',
		'\u00b7',
		'This is a very long title that will be truncated',
		30,
	);
	// available = 30 - 3 - 7 = 20 chars for title
	// "This is a very long " is 20 chars \u2192 "This is a very long\u2026" = 19 + ellipsis
	t.is(row, '\u00b7 STA-400 This is a very long\u2026');
});

test('renderListRow: narrow width, no title room', t => {
	const row = renderListRow('STA-400', '\u00b7', 'Hello', 10);
	// available = 10 - 3 - 7 = 0, no title
	t.is(row, '\u00b7 STA-400 ');
});

// ============================================================================
// ASCII ART: Scrolling Visibility
//
// Row format in renderListView output:
//   "*\u00b7 STA-400 Title..."   (selected, marked with * prefix)
//   " \u00b7 STA-401 Title..."   (not selected, space prefix)
// ============================================================================

test('list view: 3 items, height 8, all visible, first selected', t => {
	const items = makeItems(3);
	const view = renderListView(items, 0, 8, 40);

	assertListView(
		t,
		view,
		`
*\u00b7 STA-400 Issue title number 1
 \u00b7 STA-401 Issue title number 2
 \u00b7 STA-402 Issue title number 3
`,
		'3 items height 8 all visible',
	);
});

test('list view: 3 items, height 8, last selected', t => {
	const items = makeItems(3);
	const view = renderListView(items, 2, 8, 40);

	assertListView(
		t,
		view,
		`
 \u00b7 STA-400 Issue title number 1
 \u00b7 STA-401 Issue title number 2
*\u00b7 STA-402 Issue title number 3
`,
		'3 items height 8 last selected',
	);
});

test('list view: 5 items, height 8 (vertical pane), first selected \u2192 shows all 5', t => {
	const items = makeItems(5);
	const view = renderListView(items, 0, 8, 40);

	// maxVisible = 8 - 2 = 6, all 5 fit
	assertListView(
		t,
		view,
		`
*\u00b7 STA-400 Issue title number 1
 \u00b7 STA-401 Issue title number 2
 \u00b7 STA-402 Issue title number 3
 \u00b7 STA-403 Issue title number 4
 \u00b7 STA-404 Issue title number 5
`,
		'5 items height 8 first selected',
	);
});

test('list view: 5 items, height 8, last selected \u2192 all visible', t => {
	const items = makeItems(5);
	const view = renderListView(items, 4, 8, 40);

	// maxVisible = 6, all 5 fit, no scrolling needed
	assertListView(
		t,
		view,
		`
 \u00b7 STA-400 Issue title number 1
 \u00b7 STA-401 Issue title number 2
 \u00b7 STA-402 Issue title number 3
 \u00b7 STA-403 Issue title number 4
*\u00b7 STA-404 Issue title number 5
`,
		'5 items height 8 last selected',
	);
});

test('list view: 8 items, height 8, middle selected \u2192 scrolled to centre', t => {
	const items = makeItems(8);
	const view = renderListView(items, 4, 8, 40);

	// maxVisible = 6, scrollOffset = min(4-3, 8-6) = min(1,2) = 1, shows items 1-6
	assertListView(
		t,
		view,
		`
 \u00b7 STA-401 Issue title number 2
 \u00b7 STA-402 Issue title number 3
 \u00b7 STA-403 Issue title number 4
*\u00b7 STA-404 Issue title number 5
 \u00b7 STA-405 Issue title number 6
 \u00b7 STA-406 Issue title number 7
`,
		'8 items height 8 middle selected scrolled',
	);
});

test('list view: 10 items, height 20, all fit, first selected', t => {
	const items = makeItems(10);
	const view = renderListView(items, 0, 20, 40);

	// maxVisible = 20 - 2 = 18, all 10 items fit
	assertListView(
		t,
		view,
		`
*\u00b7 STA-400 Issue title number 1
 \u00b7 STA-401 Issue title number 2
 \u00b7 STA-402 Issue title number 3
 \u00b7 STA-403 Issue title number 4
 \u00b7 STA-404 Issue title number 5
 \u00b7 STA-405 Issue title number 6
 \u00b7 STA-406 Issue title number 7
 \u00b7 STA-407 Issue title number 8
 \u00b7 STA-408 Issue title number 9
 \u00b7 STA-409 Issue title number 10
`,
		'10 items height 20 all visible',
	);
});

test('list view: 1 item, height 8', t => {
	const items = makeItems(1);
	const view = renderListView(items, 0, 8, 40);

	assertListView(
		t,
		view,
		`
*\u00b7 STA-400 Issue title number 1
`,
		'1 item height 8',
	);
});

test('list view: 0 items \u2192 empty', t => {
	const view = renderListView([], 0, 8, 40);
	t.is(view, '');
});

// ============================================================================
// ASCII ART: Vertical Layout (typical 8-row list pane)
//
// This is the scenario the user flagged: vertical layout gives ~8 rows to
// the list pane. With no footer (chrome = 2), we get 6 visible items.
// ============================================================================

test('vertical pane 8 rows: 5 sessions should show all 5', t => {
	const items = makeItems(5);
	const view = renderListView(items, 0, 8, 50);

	const lines = view.trim().split('\n');
	t.is(lines.length, 5, 'Should show all 5 items in 8-row pane');
});

test('vertical pane 8 rows: 3 sessions should show all 3', t => {
	const items = makeItems(3);
	const view = renderListView(items, 0, 8, 50);

	const lines = view.trim().split('\n');
	t.is(lines.length, 3, 'All 3 items visible in 8-row pane');
});

test('vertical pane 8 rows: 10 sessions should show 6 (scrollable)', t => {
	const items = makeItems(10);
	const view = renderListView(items, 0, 8, 50);

	const lines = view.trim().split('\n');
	t.is(lines.length, 6, 'Should show 6 items in 8-row pane');
});

// ============================================================================
// ASCII ART: Title Truncation at Different Widths
// ============================================================================

test('list view: narrow width 20, title truncated heavily', t => {
	const items = [
		{
			issueKey: 'STA-400',
			icon: '\u00b7',
			title: 'Implement user authentication flow',
		},
	];
	const view = renderListView(items, 0, 8, 20);

	// available = 20 - 3 - 7 = 10 chars for title
	// title is 34 chars > 10, so truncated to 9 + ellipsis
	assertListView(t, view, '*\u00b7 STA-400 Implement\u2026', 'narrow width 20');
});

test('list view: medium width 35, title partially visible', t => {
	const items = [
		{
			issueKey: 'STA-400',
			icon: '\u00b7',
			title: 'Implement user authentication flow',
		},
	];
	const view = renderListView(items, 0, 8, 35);

	// available = 35 - 3 - 7 = 25 chars for title
	// title is 34 chars > 25, so truncated to slice(0,24) + ellipsis
	assertListView(
		t,
		view,
		'*\u00b7 STA-400 Implement user authentic\u2026',
		'medium width 35',
	);
});

test('list view: wide width 50, title fully visible', t => {
	const items = [
		{issueKey: 'STA-400', icon: '\u00b7', title: 'Implement user auth'},
	];
	const view = renderListView(items, 0, 8, 50);

	// available = 50 - 3 - 7 = 40 chars, title is 19 chars \u2192 fits
	assertListView(
		t,
		view,
		'*\u00b7 STA-400 Implement user auth',
		'wide width 50',
	);
});

test('list view: width 12, very short title area', t => {
	const items = [{issueKey: 'STA-400', icon: '\u00b7', title: 'AB'}];
	const view = renderListView(items, 0, 8, 12);

	// available = 12 - 3 - 7 = 2 chars for title \u2192 "AB" fits exactly
	assertListView(t, view, '*\u00b7 STA-400 AB', 'width 12 short title');
});

test('list view: width 10, no room for title', t => {
	const items = [
		{issueKey: 'STA-400', icon: '\u00b7', title: 'Should not appear'},
	];
	const view = renderListView(items, 0, 8, 10);

	// available = 10 - 3 - 7 = 0, no title
	assertListView(t, view, '*\u00b7 STA-400 ', 'width 10 no title');
});

// ============================================================================
// ASCII ART: Different Status Icons
// ============================================================================

test('list view: various status icons', t => {
	const items = [
		{issueKey: 'STA-400', icon: '\u25cb', title: 'Waiting for input'}, // \u25cb
		{issueKey: 'STA-401', icon: '!', title: 'Needs approval'},
		{issueKey: 'STA-402', icon: '?', title: 'Has a question'},
		{issueKey: 'STA-403', icon: '\u00b7', title: 'Session ended'}, // \u00b7
		{issueKey: 'STA-404', icon: '\u2717', title: 'Error occurred'}, // \u2717
	];
	const view = renderListView(items, 1, 10, 40);

	assertListView(
		t,
		view,
		`
 \u25cb STA-400 Waiting for input
*! STA-401 Needs approval
 ? STA-402 Has a question
 \u00b7 STA-403 Session ended
 \u2717 STA-404 Error occurred
`,
		'various status icons',
	);
});

// ============================================================================
// ASCII ART: Large Scroll Scenarios
// ============================================================================

test('list view: 15 items, height 10, scrolling through', t => {
	const items = makeItems(15);
	// maxVisible = 10 - 2 = 8

	// At beginning (selected 0)
	const viewStart = renderListView(items, 0, 10, 40);
	let lines = viewStart.split('\n');
	t.is(lines.length, 8, 'Shows 8 items');
	t.true(lines[0]!.startsWith('*'), 'First item selected at start');
	t.true(lines[0]!.includes('STA-400'), 'First item is STA-400');
	t.true(lines[7]!.includes('STA-407'), 'Last visible is STA-407');

	// At middle (selected 7)
	const viewMid = renderListView(items, 7, 10, 40);
	lines = viewMid.split('\n');
	t.is(lines.length, 8, 'Shows 8 items');
	// scrollOffset = min(7-4, 15-8) = min(3, 7) = 3
	t.true(lines[0]!.includes('STA-403'), 'Scrolled: first visible is STA-403');
	t.true(lines[4]!.startsWith('*'), 'Selected item has * prefix');
	t.true(lines[4]!.includes('STA-407'), 'Selected item is STA-407');

	// At end (selected 14)
	const viewEnd = renderListView(items, 14, 10, 40);
	lines = viewEnd.split('\n');
	t.is(lines.length, 8, 'Shows 8 items');
	// scrollOffset = min(14-4, 15-8) = min(10, 7) = 7
	t.true(
		lines[0]!.includes('STA-407'),
		'Scrolled to end: first visible is STA-407',
	);
	t.true(lines[7]!.startsWith('*'), 'Last item selected');
	t.true(lines[7]!.includes('STA-414'), 'Last item is STA-414');
});

// ============================================================================
// REAL-WORLD SCENARIOS
// ============================================================================

test('scenario: vertical layout, 8-row pane, 6 active sessions', t => {
	// With no footer (chrome = 2), we get maxVisible = 6 — all items fit!
	const items = makeItems(6);
	const view = renderListView(items, 0, 8, 50);

	assertListView(
		t,
		view,
		`
*\u00b7 STA-400 Issue title number 1
 \u00b7 STA-401 Issue title number 2
 \u00b7 STA-402 Issue title number 3
 \u00b7 STA-403 Issue title number 4
 \u00b7 STA-404 Issue title number 5
 \u00b7 STA-405 Issue title number 6
`,
		'vertical 8-row pane, 6 sessions, first selected',
	);
});

test('scenario: vertical layout, 8-row pane, 6 sessions, 5th selected', t => {
	const items = makeItems(6);
	const view = renderListView(items, 4, 8, 50);

	// maxVisible = 6, all 6 fit, no scrolling needed
	assertListView(
		t,
		view,
		`
 \u00b7 STA-400 Issue title number 1
 \u00b7 STA-401 Issue title number 2
 \u00b7 STA-402 Issue title number 3
 \u00b7 STA-403 Issue title number 4
*\u00b7 STA-404 Issue title number 5
 \u00b7 STA-405 Issue title number 6
`,
		'vertical 8-row pane, 6 sessions, 5th selected',
	);
});

test('scenario: horizontal layout, tall terminal, 10 sessions', t => {
	// In horizontal layout, the list pane shares the full terminal height
	// e.g. 45 rows = maxVisible = 43
	const items = makeItems(10);
	const view = renderListView(items, 0, 45, 40);

	const lines = view.trim().split('\n');
	t.is(lines.length, 10, 'All 10 items visible in tall terminal');
});

test('scenario: MacBook Pro half-width, 4-row list pane (minimal)', t => {
	// Very small pane: 4 rows. maxVisible = max(1, 4-2) = 2
	const items = makeItems(5);
	const view = renderListView(items, 2, 4, 40);

	const lines = view.trim().split('\n');
	t.is(lines.length, 2, '2 items visible in tiny 4-row pane');
	t.true(
		lines[0]!.includes('STA-401') || lines[1]!.includes('STA-402'),
		'Shows the selected item',
	);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('edge: selected index beyond items', t => {
	// Should not crash, just show what's available
	const w = calculateVisibleWindow(10, 3, 8);
	// scrollOffset = min(10-2, 3-4) = min(8, -1) = max(0, -1) = 0
	t.is(w.scrollOffset, 0);
});

test('edge: height equals chrome exactly', t => {
	// termHeight = 2 = LIST_CHROME_ROWS, maxVisible = max(1, 0) = 1
	t.is(calculateMaxVisibleItems(2), 1);
});

test('edge: single item always visible regardless of height', t => {
	const items = makeItems(1);
	for (const h of [4, 5, 8, 20, 100]) {
		const view = renderListView(items, 0, h, 40);
		const lines = view.trim().split('\n');
		t.is(lines.length, 1, `Single item visible at height ${h}`);
	}
});

test('edge: variable-length keys get different title room', t => {
	// Short key gets more title room than long key at same width
	const shortKeyRow = renderListRow('STA-1', '\u00b7', 'A title here', 30);
	const longKeyRow = renderListRow('STA-9999', '\u00b7', 'A title here', 30);

	// STA-1: available = 30 - 3 - 5 = 22, title fits
	t.is(shortKeyRow, '\u00b7 STA-1 A title here');
	// STA-9999: available = 30 - 3 - 8 = 19, title fits
	t.is(longKeyRow, '\u00b7 STA-9999 A title here');
});

// ============================================================================
// Consistency with Old Behaviour Documentation
//
// These tests document the old (buggy) vs new (fixed) behaviour so the
// improvement is clear.
// ============================================================================

test('regression: old code showed only 2 items in 8-row pane (now 6)', t => {
	// Old formula: maxVisible = termHeight - 6 = 8 - 6 = 2
	// Current formula (no footer): maxVisible = termHeight - 2 = 8 - 2 = 6
	const maxVisible = calculateMaxVisibleItems(8);
	t.is(maxVisible, 6);
	t.not(maxVisible, 2, 'Should NOT be 2 (old buggy value)');
});

test('regression: old code showed 4 items in 10-row pane (now 8)', t => {
	const maxVisible = calculateMaxVisibleItems(10);
	t.is(maxVisible, 8);
	t.not(maxVisible, 4, 'Should NOT be 4 (old buggy value)');
});

// ============================================================================
// STA-460: Stale dimension regression tests
//
// When pappardelle first loads in tmux, the list pane gets split from the
// full terminal window. Before the fix, stdout.columns reflected the
// PRE-SPLIT terminal width (e.g. 160 for a full-screen window) instead of
// the POST-SPLIT list pane width (e.g. 37). This caused rows to be rendered
// for a width much wider than the actual pane, so tmux clipped them — making
// issue keys appear truncated and spacing appear broken.
//
// The fix queries tmux directly for the pane dimensions on initialization.
// These tests document the visual difference between stale and correct widths.
// ============================================================================

test('STA-460: correct pane width renders issue key fully within pane', t => {
	// After tmux split, list pane is ~37 chars wide (horizontal layout, 160-wide terminal)
	const correctWidth = 37;
	const items = [
		{issueKey: 'STA-460', icon: '·', title: 'Fix pappardelle initialization'},
	];

	// renderListRow uses the full width for content (no prefix)
	const row = renderListRow(
		'STA-460',
		'·',
		'Fix pappardelle initialization',
		correctWidth,
	);

	// available = 37 - 3 - 7 = 27 chars for title
	// Title "Fix pappardelle initialization" is 30 chars > 27
	// Truncated to 26 + ellipsis = 27
	t.is(row, '· STA-460 Fix pappardelle initializa\u2026');
	t.is(row.length, correctWidth, 'Row fills exactly the pane width');
	t.true(row.includes('STA-460'), 'Issue key must not be truncated');
});

test('STA-460: stale pre-split width produces rows wider than actual pane', t => {
	// Before fix: stdout.columns was still the full terminal width (160)
	const staleWidth = 160;
	// After fix: tmux reports the actual list pane width (37)
	const correctWidth = 37;

	const items = [
		{issueKey: 'STA-460', icon: '·', title: 'Fix pappardelle initialization'},
	];

	const staleRow = renderListRow(
		'STA-460',
		'·',
		'Fix pappardelle initialization',
		staleWidth,
	);
	const correctRow = renderListRow(
		'STA-460',
		'·',
		'Fix pappardelle initialization',
		correctWidth,
	);

	// Stale row is way wider than the pane — tmux would clip it
	t.true(
		staleRow.length > correctWidth,
		'Stale-width row overflows actual pane (this caused the visual bug)',
	);

	// Correct row fits within the pane
	t.true(
		correctRow.length <= correctWidth,
		'Correct-width row fits within the pane',
	);

	// Both rows have the full issue key (the key itself isn't the problem,
	// tmux clipping at the pane boundary is what made it look truncated)
	t.true(staleRow.includes('STA-460'));
	t.true(correctRow.includes('STA-460'));
});

test('STA-460: multiple rows with stale width all overflow the pane', t => {
	// renderListRow is the content-only row (matches SpaceListItem in the real app).
	// We compare row lengths directly against the pane width.
	const staleWidth = 160;
	const correctWidth = 37;

	const rows = [
		{key: 'STA-460', title: 'Fix pappardelle initialization'},
		{key: 'STA-459', title: 'Add permanent main worktree row'},
		{key: 'STA-449', title: 'Multi-Provider Music Integration'},
	];

	for (const {key, title} of rows) {
		const staleRow = renderListRow(key, '·', title, staleWidth);
		const correctRow = renderListRow(key, '·', title, correctWidth);

		// Stale row overflows the actual pane — tmux would clip it
		t.true(
			staleRow.length > correctWidth,
			`Stale row overflows: "${staleRow}" (${staleRow.length} > ${correctWidth})`,
		);

		// Correct row fits within the pane
		t.true(
			correctRow.length <= correctWidth,
			`Correct row fits: "${correctRow}" (${correctRow.length} <= ${correctWidth})`,
		);
	}
});

test('STA-460: stale height affects visible item count', t => {
	// Pre-split: full terminal is 45 rows tall
	// Post-split: list pane is only 8 rows tall (vertical layout)
	const staleHeight = 45;
	const correctHeight = 8;

	// With stale height: maxVisible = 45 - 2 = 43
	// With correct height: maxVisible = 8 - 2 = 6
	t.is(calculateMaxVisibleItems(staleHeight), 43);
	t.is(calculateMaxVisibleItems(correctHeight), 6);

	// The stale height would try to render way more items than fit in the pane,
	// causing Ink to overflow and produce rendering artifacts
	const items = makeItems(10);
	const staleWindow = calculateVisibleWindow(0, 10, staleHeight);
	const correctWindow = calculateVisibleWindow(0, 10, correctHeight);

	// Stale: all 10 items "visible" (but pane can only show ~6)
	t.is(staleWindow.visibleCount, 10);
	// Correct: 6 items visible with scrolling
	t.is(correctWindow.visibleCount, 6);
});
