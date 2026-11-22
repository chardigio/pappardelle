import test from 'ava';
import {
	twoLineTitleIndent,
	titleSharesKeyLine,
	calculateScrollOffset,
	calculateRowWindow,
	calculateAvailableTitleWidth,
	truncateTitle,
	renderListRow,
	railPrefixWidth,
	rowPrefixWidth,
	ROW_FIXED_OVERHEAD,
	ROW_ICON_CELLS,
	clipIssueKey,
	railListRows,
	railWindow,
	spaceCountLabel,
	statusLineFits,
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

test('constants: ROW_FIXED_OVERHEAD = 3 (icon + 2 spaces)', t => {
	t.is(ROW_FIXED_OVERHEAD, 3);
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
// Row prefix (profile emoji)
// ============================================================================

test('rowPrefixWidth: undefined \u2192 0', t => {
	t.is(rowPrefixWidth(undefined), 0);
});

test('rowPrefixWidth: missing emoji \u2192 0', t => {
	t.is(rowPrefixWidth({}), 0);
});

test('rowPrefixWidth: default width 2 + trailing space = 3', t => {
	t.is(rowPrefixWidth({emoji: '\ud83c\udf5d'}), 3);
});

test('rowPrefixWidth: explicit width 1 (e.g. ASCII glyph) \u2192 2', t => {
	t.is(rowPrefixWidth({emoji: '*', width: 1}), 2);
});

test('calculateAvailableTitleWidth: shrinks by emoji prefix', t => {
	// totalWidth=40, issueKey=7, no rail icons:
	// without prefix: 40 - 3 - 7 = 30
	// with default-width emoji prefix (3 cells): 30 - 3 = 27
	t.is(calculateAvailableTitleWidth(40, 7), 30);
	t.is(
		calculateAvailableTitleWidth(40, 7, undefined, {emoji: '\ud83c\udf5d'}),
		27,
	);
});

test('renderListRow: with emoji prefix', t => {
	const row = renderListRow('STA-452', '\u00b7', 'Fix the bug', 40, undefined, {
		emoji: '\ud83c\udf5d',
	});
	// emoji prefix (3 cells) renders as "\ud83c\udf5d " then the rest of the row.
	t.is(row, '\ud83c\udf5d \u00b7 STA-452 Fix the bug');
});

test('renderListRow: emoji prefix shrinks title budget', t => {
	const row = renderListRow(
		'STA-400',
		'\u00b7',
		'This is a very long title that will be truncated',
		30,
		undefined,
		{emoji: '\ud83c\udf5d'},
	);
	// available = 30 - 3 - 7 - 3 = 17 chars for title
	// "This is a very lo" = 17 \u2192 truncated to "This is a very l\u2026" (16 + ellipsis)
	t.is(row, '\ud83c\udf5d \u00b7 STA-400 This is a very l\u2026');
});

// Regression: when `prefix` is undefined (the case for users who haven't
// added any emoji fields to their .pappardelle.yml), renderListRow MUST
// produce byte-for-byte the same string it did on master. If this ever
// drifts, every existing user gets an unexpected blank slot pushing their
// rows over by 3 cells on upgrade.
test('renderListRow: no prefix arg \u2192 row is byte-identical to master output', t => {
	const noPrefix = renderListRow('STA-452', '\u00b7', 'Fix the bug', 40);
	const explicitUndefined = renderListRow(
		'STA-452',
		'\u00b7',
		'Fix the bug',
		40,
		undefined,
		undefined,
	);
	t.is(noPrefix, '\u00b7 STA-452 Fix the bug');
	t.is(explicitUndefined, '\u00b7 STA-452 Fix the bug');
	// Available title width must also match master: 40 - 3 - 7 = 30.
	t.is(calculateAvailableTitleWidth(40, 7), 30);
	t.is(calculateAvailableTitleWidth(40, 7, undefined, undefined), 30);
});

// ============================================================================
// Edge Cases
// ============================================================================

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

// ============================================================================
// Rail icons: pipeline + unresolved comment count
// ============================================================================

test('railPrefixWidth: no icons → 0', t => {
	t.is(railPrefixWidth(), 0);
	t.is(railPrefixWidth({}), 0);
	t.is(railPrefixWidth({pipelineIcon: '', commentCount: 0}), 0);
});

test('railPrefixWidth: single-cell pipeline icon → 2 (icon + trailing space)', t => {
	t.is(railPrefixWidth({pipelineIcon: '✓'}), 2);
	t.is(railPrefixWidth({pipelineIcon: '✗'}), 2);
	t.is(railPrefixWidth({pipelineIcon: '◔'}), 2);
});

test('railPrefixWidth: two-cell pipeline icon ◐◑ → 3 (2 cells + trailing space)', t => {
	t.is(railPrefixWidth({pipelineIcon: '◐◑'}), 3);
});

test('railPrefixWidth: single-digit comment count only → 4 (paren + 1 digit + paren + space)', t => {
	t.is(railPrefixWidth({commentCount: 3}), 4);
});

test('railPrefixWidth: double-digit comment count only → 5', t => {
	t.is(railPrefixWidth({commentCount: 12}), 5);
});

test('railPrefixWidth: pipeline + comment combined', t => {
	// pipeline ✓ (2) + (1) (4) = 6
	t.is(railPrefixWidth({pipelineIcon: '✓', commentCount: 1}), 6);
	// pipeline ◐◑ (3) + (99) (5) = 8
	t.is(railPrefixWidth({pipelineIcon: '◐◑', commentCount: 99}), 8);
});

// ----------------------------------------------------------------------------
// calculateAvailableTitleWidth with rail icons
// ----------------------------------------------------------------------------

test('titleWidth w/ pipeline ✓: width 40, key STA-452 → 28', t => {
	// 40 - 3 - 7 - 2 (pipeline prefix) = 28
	t.is(calculateAvailableTitleWidth(40, 7, {pipelineIcon: '✓'}), 28);
});

test('titleWidth w/ ◐◑ pipeline: width 40, key STA-452 → 27', t => {
	// 40 - 3 - 7 - 3 (pipeline prefix) = 27
	t.is(calculateAvailableTitleWidth(40, 7, {pipelineIcon: '◐◑'}), 27);
});

test('titleWidth w/ pipeline + comments: width 40, key STA-452 → 24', t => {
	// 40 - 3 - 7 - 2 (pipeline) - 4 (comment chunk, 1 digit) = 24
	t.is(
		calculateAvailableTitleWidth(40, 7, {
			pipelineIcon: '✓',
			commentCount: 2,
		}),
		24,
	);
});

test('titleWidth clamps to 0 when icons eat all space', t => {
	t.is(
		calculateAvailableTitleWidth(10, 7, {
			pipelineIcon: '◐◑',
			commentCount: 9,
		}),
		0,
	);
});

// ----------------------------------------------------------------------------
// renderListRow with rail icons
// ----------------------------------------------------------------------------

test('renderListRow: passing pipeline, no comments', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
	});
	t.is(row, '· STA-452 Fix the bug ✓');
});

test('renderListRow: failing pipeline, no comments', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✗',
	});
	t.is(row, '· STA-452 Fix the bug ✗');
});

test('renderListRow: progressing_clean, no comments', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '◔',
	});
	t.is(row, '· STA-452 Fix the bug ◔');
});

test('renderListRow: progressing_dirty ◐◑, no comments', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '◐◑',
	});
	t.is(row, '· STA-452 Fix the bug ◐◑');
});

test('renderListRow: comments only (e.g. no checks but review threads) → no pipeline, (count) shown', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		commentCount: 4,
	});
	t.is(row, '· STA-452 Fix the bug (4)');
});

test('renderListRow: pipeline + comments (comments first, pipeline at far right)', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		commentCount: 2,
	});
	t.is(row, '· STA-452 Fix the bug (2) ✓');
});

// ----------------------------------------------------------------------------
// Conflict indicator (STA-964): rendered between unresolved-comment count and
// pipeline icon when the PR can't be merged due to conflicts.
// ----------------------------------------------------------------------------

test('railPrefixWidth: hasConflict adds 2 cells (leading space + ↯)', t => {
	t.is(railPrefixWidth({hasConflict: true}), 2);
	t.is(railPrefixWidth({hasConflict: false}), 0);
});

test('railPrefixWidth: conflict + pipeline + comments stacks correctly', t => {
	// pipeline ✓ (2) + conflict (2) + comments (4) = 8
	t.is(
		railPrefixWidth({
			pipelineIcon: '✓',
			commentCount: 1,
			hasConflict: true,
		}),
		8,
	);
});

test('titleWidth shrinks by 2 when conflict indicator is shown', t => {
	// 40 - 3 - 7 - 2 (pipeline) - 2 (conflict) = 26
	t.is(
		calculateAvailableTitleWidth(40, 7, {
			pipelineIcon: '✓',
			hasConflict: true,
		}),
		26,
	);
});

test('renderListRow: conflict between comment count and pipeline (left → right: comments, ↯, pipeline)', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		commentCount: 2,
		hasConflict: true,
	});
	t.is(row, '· STA-452 Fix the bug (2) ↯ ✓');
});

test('renderListRow: conflict alone with pipeline (no comments)', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		hasConflict: true,
	});
	t.is(row, '· STA-452 Fix the bug ↯ ✓');
});

test('renderListRow: conflict alone without pipeline (no comments, no pipeline icon)', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		hasConflict: true,
	});
	t.is(row, '· STA-452 Fix the bug ↯');
});

test('renderListRow: hasConflict false renders identically to no flag', t => {
	const without = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
	});
	const withFalse = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		hasConflict: false,
	});
	t.is(withFalse, without);
});

test('renderListRow: zero comment count hides comment chunk', t => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		commentCount: 0,
	});
	t.is(row, '· STA-452 Fix the bug ✓');
});

test('renderListRow: icons truncate title correctly', t => {
	const row = renderListRow(
		'STA-400',
		'·',
		'This is a very long title that will be truncated',
		30,
		{pipelineIcon: '✓'},
	);
	// available = 30 - 3 - 7 - 2 = 18 chars, title truncated to 17 + ellipsis,
	// then " ✓" appended on the right
	t.is(row, '· STA-400 This is a very lo… ✓');
});

// ============================================================================
// Issue key clipping (STA-2040, hand-narrowed rail)
// ============================================================================

test('clipIssueKey leaves a key alone at ordinary widths', t => {
	t.is(clipIssueKey('STA-2040', 35), 'STA-2040');
	t.is(clipIssueKey('STA-2040', 8), 'STA-2040');
});

test('clipIssueKey clips a key that cannot fit', t => {
	t.is(clipIssueKey('STA-2040', 6), 'STA-20');
	t.is(clipIssueKey('STA-2040', 1), 'S');
});

test('clipIssueKey returns nothing when no columns remain', t => {
	t.is(clipIssueKey('STA-2040', 0), '');
	t.is(clipIssueKey('STA-2040', -4), '');
});

test('clipIssueKey keeps a row inside an 8-column rail', t => {
	// 8 columns: icon(1) + space(1) leaves 6 for the key, so the row is 8 wide
	// and never wraps onto a second line.
	const clipped = clipIssueKey('STA-2040', 8 - ROW_ICON_CELLS);
	t.is(ROW_ICON_CELLS + clipped.length, 8);
});

test('clipIssueKey leaves room for the trailing rail icons', t => {
	// A space with an open PR: a passing pipeline plus 3 unresolved comments.
	const icons = {pipelineIcon: '\u2713', commentCount: 3, hasConflict: false};
	const trailing = railPrefixWidth(icons);
	const width = 12;
	const clipped = clipIssueKey('STA-2040', width - ROW_ICON_CELLS - trailing);
	// icon + space + key + the right-aligned icons all fit inside the rail, so
	// the row cannot wrap onto a second line.
	t.true(ROW_ICON_CELLS + clipped.length + trailing <= width);
	t.true(clipped.length > 0);
});

test('clipIssueKey with rail icons at the 8-column floor still fits', t => {
	const icons = {pipelineIcon: '\u2713', commentCount: 0, hasConflict: true};
	const trailing = railPrefixWidth(icons);
	const clipped = clipIssueKey('STA-2040', 8 - ROW_ICON_CELLS - trailing);
	t.true(ROW_ICON_CELLS + clipped.length + trailing <= 8);
});

// ============================================================================
// twoLineTitleIndent — the title row must start in the same column as the
// issue key above it, or the two lines read as unrelated rows.
// ============================================================================

test('twoLineTitleIndent clears the status icon and its space', t => {
	t.is(twoLineTitleIndent(), 2);
});

test('twoLineTitleIndent clears a 2-cell emoji prefix too', t => {
	t.is(twoLineTitleIndent({emoji: '\u{1F35D}', width: 2}), 5);
});

test('twoLineTitleIndent aligns with where the issue key starts', t => {
	// renderListRow lays out "<emoji> <icon> <key>"; the indent must equal the
	// offset of the key within that row.
	const prefix = {emoji: '\u{1F35D}', width: 2};
	const row = renderListRow('sta-1', '\u25CF', 'title', 40, undefined, prefix);
	t.is(row.indexOf('sta-1'), twoLineTitleIndent(prefix));
});

test('twoLineTitleIndent aligns with the key when there is no emoji', t => {
	const row = renderListRow('sta-1', '\u25CF', 'title', 40);
	t.is(row.indexOf('sta-1'), twoLineTitleIndent());
});

// ============================================================================
// titleSharesKeyLine — a pending row's progress text ("Starting new session…")
// has to sit beside the spinner on the first line, not on the indented title
// line below it.
// ============================================================================

test('titleSharesKeyLine: single-line layout always shares the row', t => {
	t.true(titleSharesKeyLine({isTwoLine: false}));
	t.true(titleSharesKeyLine({isTwoLine: false, isPending: true}));
});

test('titleSharesKeyLine: two-line layout gives real spaces their own title row', t => {
	t.false(titleSharesKeyLine({isTwoLine: true}));
	t.false(titleSharesKeyLine({isTwoLine: true, isPending: false}));
});

test('titleSharesKeyLine: two-line pending rows keep the text on the key line', t => {
	t.true(titleSharesKeyLine({isTwoLine: true, isPending: true}));
});

test('the split rail never outgrows a short pane', t => {
	for (const linesPerItem of [1, 2] as const) {
		for (const bannerHeight of [0, 4]) {
			for (const agentRows of [1, 3]) {
				for (
					let paneRows = bannerHeight + 4 + agentRows + linesPerItem;
					paneRows <= bannerHeight + 14;
					paneRows++
				) {
					const statusRows = statusLineFits(
						paneRows,
						bannerHeight,
						agentRows,
						linesPerItem,
					)
						? 1
						: 0;
					const listRows = railListRows({
						merged: false,
						paneRows,
						bannerHeight,
						statusRows,
						agentRows,
					});
					t.true(
						listRows >= linesPerItem,
						`${paneRows} rows, banner ${bannerHeight}, ${agentRows} agents: ${listRows} list rows`,
					);
				}
			}
		}
	}
});

test('the status row gives way before the last space row', t => {
	// Two frames (4) + sous-chef (1) + one space (1) + status (1).
	t.true(statusLineFits(7, 0, 1, 1));
	t.false(statusLineFits(6, 0, 1, 1));
	t.false(statusLineFits(7, 0, 1, 2));
});

test('the merged rail has one frame and one status or search row', t => {
	t.is(railListRows({merged: true, paneRows: 20, bannerHeight: 0}), 17);
	t.is(railListRows({merged: true, paneRows: 20, bannerHeight: 3}), 14);
	t.is(
		railListRows({
			merged: false,
			paneRows: 20,
			bannerHeight: 0,
			statusRows: 1,
			agentRows: 1,
		}),
		14,
	);
});

test('the stacked rail gives its status row to the list when the row has nothing to show', t => {
	// STA-3146: the workspace name and the count sit in the frame's border, so
	// an idle status row was a blank row.
	t.is(
		railListRows({merged: true, paneRows: 7, bannerHeight: 0, statusRows: 0}),
		5,
	);
	const rows = Array.from({length: 10}, () => ({height: 1, isSpace: true}));
	const layout = {
		merged: true,
		rows,
		cursorRow: 0,
		paneRows: 6,
		bannerHeight: 0,
		agentRows: 0,
		linesPerItem: 1 as const,
	};
	const idle = railWindow({...layout, statusShown: false});
	t.false(idle.statusFits);
	t.is(idle.listRows, 4);
	// A message or the search row takes the row back.
	const busy = railWindow(layout);
	t.true(busy.statusFits);
	t.is(busy.listRows, 3);
});

// ============================================================================
// calculateRowWindow (grouped rail: one-line headers, 1- or 2-line spaces)
// ============================================================================

test('calculateRowWindow fits mixed heights within the pane', t => {
	// header, space, space, header, space, space, header, space (two-line layout)
	const heights = [1, 2, 2, 1, 2, 2, 1, 2];
	for (let cursor = 0; cursor < heights.length; cursor++) {
		const {scrollOffset, visibleCount} = calculateRowWindow(heights, cursor, 7);
		const lines = heights
			.slice(scrollOffset, scrollOffset + visibleCount)
			.reduce((sum, height) => sum + height, 0);
		t.true(lines <= 7, `cursor ${cursor} overflows with ${lines} lines`);
		t.true(cursor >= scrollOffset && cursor < scrollOffset + visibleCount);
	}
});

test('calculateRowWindow fills the pane at the end of the list', t => {
	const heights = [1, 2, 2, 1, 2, 2, 1, 2];
	t.deepEqual(calculateRowWindow(heights, 7, 7), {
		scrollOffset: 4,
		visibleCount: 4,
	});
});

test('the space count shows a range only while some spaces are off screen', t => {
	t.is(spaceCountLabel(1, 12, 12), '12 spaces');
	t.is(spaceCountLabel(1, 1, 1), '1 space');
	t.is(spaceCountLabel(4, 6, 12), '4-9 of 12');
	t.is(spaceCountLabel(6, 1, 6), '6 of 6');
	t.is(spaceCountLabel(1, 0, 35), '35 spaces');
	t.is(spaceCountLabel(1, 0, 0), undefined);
});

test('the status row gives way when a group header would take the only list row', t => {
	// In Progress header, then two-line spaces; the sous-chef row sits above.
	const rows = [
		{height: 1, isSpace: false},
		...Array.from({length: 10}, () => ({height: 2, isSpace: true})),
	];
	const layout = {
		merged: false,
		rows,
		paneRows: 8,
		bannerHeight: 0,
		agentRows: 1,
	};
	// Cursor on the sous-chef: the window starts at the header.
	const atTop = railWindow({...layout, cursorRow: -1, linesPerItem: 2});
	t.false(atTop.statusFits);
	t.deepEqual(
		rows.slice(atTop.scrollOffset, atTop.scrollOffset + atTop.visibleCount),
		[rows[0], rows[1]],
	);
	// Cursor deep in the list: the header has scrolled out, so the status row stays.
	const deep = railWindow({...layout, cursorRow: 6, linesPerItem: 2});
	t.true(deep.statusFits);
	t.is(deep.listRows, 2);
	t.is(deep.scrollOffset, 6);
});
