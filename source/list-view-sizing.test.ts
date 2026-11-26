import {test, expect} from 'bun:test';
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
// Constants Verification
// ============================================================================

test('constants: ROW_FIXED_OVERHEAD = 3 (icon + 2 spaces)', () => {
	expect(ROW_FIXED_OVERHEAD).toBe(3);
});

// ============================================================================
// calculateScrollOffset
// ============================================================================

test('scrollOffset: first item selected, no scroll', () => {
	expect(calculateScrollOffset(0, 10, 5)).toBe(0);
});

test('scrollOffset: second item selected, no scroll', () => {
	expect(calculateScrollOffset(1, 10, 5)).toBe(0);
});

test('scrollOffset: middle item selected, centred', () => {
	// selectedIndex=5, maxVisible=5 → 5 - floor(5/2) = 3
	expect(calculateScrollOffset(5, 10, 5)).toBe(3);
});

test('scrollOffset: last item selected, clamped to end', () => {
	// selectedIndex=9, maxVisible=5 → min(9-2, 10-5) = min(7, 5) = 5
	expect(calculateScrollOffset(9, 10, 5)).toBe(5);
});

test('scrollOffset: all items fit, always 0', () => {
	expect(calculateScrollOffset(0, 3, 5)).toBe(0);
	expect(calculateScrollOffset(1, 3, 5)).toBe(0);
	expect(calculateScrollOffset(2, 3, 5)).toBe(0);
});

test('scrollOffset: items == maxVisible, always 0', () => {
	expect(calculateScrollOffset(0, 5, 5)).toBe(0);
	expect(calculateScrollOffset(2, 5, 5)).toBe(0);
	expect(calculateScrollOffset(4, 5, 5)).toBe(0);
});

// ============================================================================
// Row Rendering: Title Width
//
// New format: "icon(1) space(1) issueKey(var) space(1) title"
// Fixed overhead = 3, total fixed = 3 + issueKey.length
// ============================================================================

test('titleWidth: width 40, key "STA-452" (7) \u2192 30 chars for title', () => {
	// 40 - 3 - 7 = 30
	expect(calculateAvailableTitleWidth(40, 7)).toBe(30);
});

test('titleWidth: width 30, key "STA-452" (7) \u2192 20 chars for title', () => {
	expect(calculateAvailableTitleWidth(30, 7)).toBe(20);
});

test('titleWidth: width 50, key "STA-452" (7) \u2192 40 chars for title', () => {
	expect(calculateAvailableTitleWidth(50, 7)).toBe(40);
});

test('titleWidth: width 10, key "STA-452" (7) \u2192 0 chars (no room)', () => {
	// 10 - 3 - 7 = 0
	expect(calculateAvailableTitleWidth(10, 7)).toBe(0);
});

test('titleWidth: width 8, key "STA-452" (7) \u2192 0 chars (clamped)', () => {
	expect(calculateAvailableTitleWidth(8, 7)).toBe(0);
});

test('titleWidth: short key "STA-1" (5) gives more room', () => {
	// 40 - 3 - 5 = 32
	expect(calculateAvailableTitleWidth(40, 5)).toBe(32);
});

test('titleWidth: long key "STA-9999" (8) gives less room', () => {
	// 40 - 3 - 8 = 29
	expect(calculateAvailableTitleWidth(40, 8)).toBe(29);
});

// ============================================================================
// Row Rendering: Title Truncation
// ============================================================================

test('truncate: short title fits', () => {
	expect(truncateTitle('Hello', 10)).toBe('Hello');
});

test('truncate: exact fit', () => {
	expect(truncateTitle('Hello', 5)).toBe('Hello');
});

test('truncate: one char over \u2192 truncated with ellipsis', () => {
	expect(truncateTitle('Hello!', 5)).toBe('Hell\u2026');
});

test('truncate: long title', () => {
	expect(truncateTitle('This is a very long issue title', 15)).toBe(
		'This is a very\u2026',
	);
});

test('truncate: zero width \u2192 empty', () => {
	expect(truncateTitle('Hello', 0)).toBe('');
});

// ============================================================================
// renderListRow
//
// New format: "icon space issueKey space title"
// No selector prefix, no padded issue key.
// ============================================================================

test('renderListRow: basic row', () => {
	const row = renderListRow('STA-452', '\u00b7', 'Fix the bug', 40);
	// available = 40 - 3 - 7 = 30, title fits
	expect(row).toBe('\u00b7 STA-452 Fix the bug');
});

test('renderListRow: different icon', () => {
	const row = renderListRow('STA-451', '?', 'Add feature', 40);
	expect(row).toBe('? STA-451 Add feature');
});

test('renderListRow: long title truncated', () => {
	const row = renderListRow(
		'STA-400',
		'\u00b7',
		'This is a very long title that will be truncated',
		30,
	);
	// available = 30 - 3 - 7 = 20 chars for title
	// "This is a very long " is 20 chars \u2192 "This is a very long\u2026" = 19 + ellipsis
	expect(row).toBe('\u00b7 STA-400 This is a very long\u2026');
});

test('renderListRow: narrow width, no title room', () => {
	const row = renderListRow('STA-400', '\u00b7', 'Hello', 10);
	// available = 10 - 3 - 7 = 0, no title
	expect(row).toBe('\u00b7 STA-400 ');
});

// ============================================================================
// Row prefix (profile emoji)
// ============================================================================

test('rowPrefixWidth: undefined \u2192 0', () => {
	expect(rowPrefixWidth(undefined)).toBe(0);
});

test('rowPrefixWidth: missing emoji \u2192 0', () => {
	expect(rowPrefixWidth({})).toBe(0);
});

test('rowPrefixWidth: default width 2 + trailing space = 3', () => {
	expect(rowPrefixWidth({emoji: '\ud83c\udf5d'})).toBe(3);
});

test('rowPrefixWidth: explicit width 1 (e.g. ASCII glyph) \u2192 2', () => {
	expect(rowPrefixWidth({emoji: '*', width: 1})).toBe(2);
});

test('calculateAvailableTitleWidth: shrinks by emoji prefix', () => {
	// totalWidth=40, issueKey=7, no rail icons:
	// without prefix: 40 - 3 - 7 = 30
	// with default-width emoji prefix (3 cells): 30 - 3 = 27
	expect(calculateAvailableTitleWidth(40, 7)).toBe(30);
	expect(
		calculateAvailableTitleWidth(40, 7, undefined, {emoji: '\ud83c\udf5d'}),
	).toBe(27);
});

test('renderListRow: with emoji prefix', () => {
	const row = renderListRow('STA-452', '\u00b7', 'Fix the bug', 40, undefined, {
		emoji: '\ud83c\udf5d',
	});
	// emoji prefix (3 cells) renders as "\ud83c\udf5d " then the rest of the row.
	expect(row).toBe('\ud83c\udf5d \u00b7 STA-452 Fix the bug');
});

test('renderListRow: emoji prefix shrinks title budget', () => {
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
	expect(row).toBe('\ud83c\udf5d \u00b7 STA-400 This is a very l\u2026');
});

// Regression: when `prefix` is undefined (the case for users who haven't
// added any emoji fields to their .pappardelle.yml), renderListRow MUST
// produce byte-for-byte the same string it did on master. If this ever
// drifts, every existing user gets an unexpected blank slot pushing their
// rows over by 3 cells on upgrade.
test('renderListRow: no prefix arg \u2192 row is byte-identical to master output', () => {
	const noPrefix = renderListRow('STA-452', '\u00b7', 'Fix the bug', 40);
	const explicitUndefined = renderListRow(
		'STA-452',
		'\u00b7',
		'Fix the bug',
		40,
		undefined,
		undefined,
	);
	expect(noPrefix).toBe('\u00b7 STA-452 Fix the bug');
	expect(explicitUndefined).toBe('\u00b7 STA-452 Fix the bug');
	// Available title width must also match master: 40 - 3 - 7 = 30.
	expect(calculateAvailableTitleWidth(40, 7)).toBe(30);
	expect(calculateAvailableTitleWidth(40, 7, undefined, undefined)).toBe(30);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('edge: variable-length keys get different title room', () => {
	// Short key gets more title room than long key at same width
	const shortKeyRow = renderListRow('STA-1', '\u00b7', 'A title here', 30);
	const longKeyRow = renderListRow('STA-9999', '\u00b7', 'A title here', 30);

	// STA-1: available = 30 - 3 - 5 = 22, title fits
	expect(shortKeyRow).toBe('\u00b7 STA-1 A title here');
	// STA-9999: available = 30 - 3 - 8 = 19, title fits
	expect(longKeyRow).toBe('\u00b7 STA-9999 A title here');
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

test('STA-460: correct pane width renders issue key fully within pane', () => {
	// After tmux split, list pane is ~37 chars wide (horizontal layout, 160-wide terminal)
	const correctWidth = 37;
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
	expect(row).toBe('· STA-460 Fix pappardelle initializa\u2026');
	expect(row.length, 'Row fills exactly the pane width').toBe(correctWidth);
	expect(row.includes('STA-460'), 'Issue key must not be truncated').toBe(true);
});

test('STA-460: stale pre-split width produces rows wider than actual pane', () => {
	// Before fix: stdout.columns was still the full terminal width (160)
	const staleWidth = 160;
	// After fix: tmux reports the actual list pane width (37)
	const correctWidth = 37;

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
	expect(
		staleRow.length > correctWidth,
		'Stale-width row overflows actual pane (this caused the visual bug)',
	).toBe(true);

	// Correct row fits within the pane
	expect(
		correctRow.length <= correctWidth,
		'Correct-width row fits within the pane',
	).toBe(true);

	// Both rows have the full issue key (the key itself isn't the problem,
	// tmux clipping at the pane boundary is what made it look truncated)
	expect(staleRow.includes('STA-460')).toBe(true);
	expect(correctRow.includes('STA-460')).toBe(true);
});

test('STA-460: multiple rows with stale width all overflow the pane', () => {
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
		expect(
			staleRow.length > correctWidth,
			`Stale row overflows: "${staleRow}" (${staleRow.length} > ${correctWidth})`,
		).toBe(true);

		// Correct row fits within the pane
		expect(
			correctRow.length <= correctWidth,
			`Correct row fits: "${correctRow}" (${correctRow.length} <= ${correctWidth})`,
		).toBe(true);
	}
});

// ============================================================================
// Rail icons: pipeline + unresolved comment count
// ============================================================================

test('railPrefixWidth: no icons → 0', () => {
	expect(railPrefixWidth()).toBe(0);
	expect(railPrefixWidth({})).toBe(0);
	expect(railPrefixWidth({pipelineIcon: '', commentCount: 0})).toBe(0);
});

test('railPrefixWidth: single-cell pipeline icon → 2 (icon + trailing space)', () => {
	expect(railPrefixWidth({pipelineIcon: '✓'})).toBe(2);
	expect(railPrefixWidth({pipelineIcon: '✗'})).toBe(2);
	expect(railPrefixWidth({pipelineIcon: '◔'})).toBe(2);
});

test('railPrefixWidth: two-cell pipeline icon ◐◑ → 3 (2 cells + trailing space)', () => {
	expect(railPrefixWidth({pipelineIcon: '◐◑'})).toBe(3);
});

test('railPrefixWidth: single-digit comment count only → 4 (paren + 1 digit + paren + space)', () => {
	expect(railPrefixWidth({commentCount: 3})).toBe(4);
});

test('railPrefixWidth: double-digit comment count only → 5', () => {
	expect(railPrefixWidth({commentCount: 12})).toBe(5);
});

test('railPrefixWidth: pipeline + comment combined', () => {
	// pipeline ✓ (2) + (1) (4) = 6
	expect(railPrefixWidth({pipelineIcon: '✓', commentCount: 1})).toBe(6);
	// pipeline ◐◑ (3) + (99) (5) = 8
	expect(railPrefixWidth({pipelineIcon: '◐◑', commentCount: 99})).toBe(8);
});

// ----------------------------------------------------------------------------
// calculateAvailableTitleWidth with rail icons
// ----------------------------------------------------------------------------

test('titleWidth w/ pipeline ✓: width 40, key STA-452 → 28', () => {
	// 40 - 3 - 7 - 2 (pipeline prefix) = 28
	expect(calculateAvailableTitleWidth(40, 7, {pipelineIcon: '✓'})).toBe(28);
});

test('titleWidth w/ ◐◑ pipeline: width 40, key STA-452 → 27', () => {
	// 40 - 3 - 7 - 3 (pipeline prefix) = 27
	expect(calculateAvailableTitleWidth(40, 7, {pipelineIcon: '◐◑'})).toBe(27);
});

test('titleWidth w/ pipeline + comments: width 40, key STA-452 → 24', () => {
	// 40 - 3 - 7 - 2 (pipeline) - 4 (comment chunk, 1 digit) = 24
	expect(
		calculateAvailableTitleWidth(40, 7, {
			pipelineIcon: '✓',
			commentCount: 2,
		}),
	).toBe(24);
});

test('titleWidth clamps to 0 when icons eat all space', () => {
	expect(
		calculateAvailableTitleWidth(10, 7, {
			pipelineIcon: '◐◑',
			commentCount: 9,
		}),
	).toBe(0);
});

// ----------------------------------------------------------------------------
// renderListRow with rail icons
// ----------------------------------------------------------------------------

test('renderListRow: passing pipeline, no comments', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
	});
	expect(row).toBe('· STA-452 Fix the bug ✓');
});

test('renderListRow: failing pipeline, no comments', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✗',
	});
	expect(row).toBe('· STA-452 Fix the bug ✗');
});

test('renderListRow: progressing_clean, no comments', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '◔',
	});
	expect(row).toBe('· STA-452 Fix the bug ◔');
});

test('renderListRow: progressing_dirty ◐◑, no comments', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '◐◑',
	});
	expect(row).toBe('· STA-452 Fix the bug ◐◑');
});

test('renderListRow: comments only (e.g. no checks but review threads) → no pipeline, (count) shown', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		commentCount: 4,
	});
	expect(row).toBe('· STA-452 Fix the bug (4)');
});

test('renderListRow: pipeline + comments (comments first, pipeline at far right)', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		commentCount: 2,
	});
	expect(row).toBe('· STA-452 Fix the bug (2) ✓');
});

// ----------------------------------------------------------------------------
// Conflict indicator (STA-964): rendered between unresolved-comment count and
// pipeline icon when the PR can't be merged due to conflicts.
// ----------------------------------------------------------------------------

test('railPrefixWidth: hasConflict adds 2 cells (leading space + ↯)', () => {
	expect(railPrefixWidth({hasConflict: true})).toBe(2);
	expect(railPrefixWidth({hasConflict: false})).toBe(0);
});

test('railPrefixWidth: conflict + pipeline + comments stacks correctly', () => {
	// pipeline ✓ (2) + conflict (2) + comments (4) = 8
	expect(
		railPrefixWidth({
			pipelineIcon: '✓',
			commentCount: 1,
			hasConflict: true,
		}),
	).toBe(8);
});

test('titleWidth shrinks by 2 when conflict indicator is shown', () => {
	// 40 - 3 - 7 - 2 (pipeline) - 2 (conflict) = 26
	expect(
		calculateAvailableTitleWidth(40, 7, {
			pipelineIcon: '✓',
			hasConflict: true,
		}),
	).toBe(26);
});

test('renderListRow: conflict between comment count and pipeline (left → right: comments, ↯, pipeline)', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		commentCount: 2,
		hasConflict: true,
	});
	expect(row).toBe('· STA-452 Fix the bug (2) ↯ ✓');
});

test('renderListRow: conflict alone with pipeline (no comments)', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		hasConflict: true,
	});
	expect(row).toBe('· STA-452 Fix the bug ↯ ✓');
});

test('renderListRow: conflict alone without pipeline (no comments, no pipeline icon)', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		hasConflict: true,
	});
	expect(row).toBe('· STA-452 Fix the bug ↯');
});

test('renderListRow: hasConflict false renders identically to no flag', () => {
	const without = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
	});
	const withFalse = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		hasConflict: false,
	});
	expect(withFalse).toBe(without);
});

test('renderListRow: zero comment count hides comment chunk', () => {
	const row = renderListRow('STA-452', '·', 'Fix the bug', 40, {
		pipelineIcon: '✓',
		commentCount: 0,
	});
	expect(row).toBe('· STA-452 Fix the bug ✓');
});

test('renderListRow: icons truncate title correctly', () => {
	const row = renderListRow(
		'STA-400',
		'·',
		'This is a very long title that will be truncated',
		30,
		{pipelineIcon: '✓'},
	);
	// available = 30 - 3 - 7 - 2 = 18 chars, title truncated to 17 + ellipsis,
	// then " ✓" appended on the right
	expect(row).toBe('· STA-400 This is a very lo… ✓');
});

// ============================================================================
// Issue key clipping (STA-2040, hand-narrowed rail)
// ============================================================================

test('clipIssueKey leaves a key alone at ordinary widths', () => {
	expect(clipIssueKey('STA-2040', 35)).toBe('STA-2040');
	expect(clipIssueKey('STA-2040', 8)).toBe('STA-2040');
});

test('clipIssueKey clips a key that cannot fit', () => {
	expect(clipIssueKey('STA-2040', 6)).toBe('STA-20');
	expect(clipIssueKey('STA-2040', 1)).toBe('S');
});

test('clipIssueKey returns nothing when no columns remain', () => {
	expect(clipIssueKey('STA-2040', 0)).toBe('');
	expect(clipIssueKey('STA-2040', -4)).toBe('');
});

test('clipIssueKey keeps a row inside an 8-column rail', () => {
	// 8 columns: icon(1) + space(1) leaves 6 for the key, so the row is 8 wide
	// and never wraps onto a second line.
	const clipped = clipIssueKey('STA-2040', 8 - ROW_ICON_CELLS);
	expect(ROW_ICON_CELLS + clipped.length).toBe(8);
});

test('clipIssueKey leaves room for the trailing rail icons', () => {
	// A space with an open PR: a passing pipeline plus 3 unresolved comments.
	const icons = {pipelineIcon: '\u2713', commentCount: 3, hasConflict: false};
	const trailing = railPrefixWidth(icons);
	const width = 12;
	const clipped = clipIssueKey('STA-2040', width - ROW_ICON_CELLS - trailing);
	// icon + space + key + the right-aligned icons all fit inside the rail, so
	// the row cannot wrap onto a second line.
	expect(ROW_ICON_CELLS + clipped.length + trailing <= width).toBe(true);
	expect(clipped.length > 0).toBe(true);
});

test('clipIssueKey with rail icons at the 8-column floor still fits', () => {
	const icons = {pipelineIcon: '\u2713', commentCount: 0, hasConflict: true};
	const trailing = railPrefixWidth(icons);
	const clipped = clipIssueKey('STA-2040', 8 - ROW_ICON_CELLS - trailing);
	expect(ROW_ICON_CELLS + clipped.length + trailing <= 8).toBe(true);
});

// ============================================================================
// twoLineTitleIndent — the title row must start in the same column as the
// issue key above it, or the two lines read as unrelated rows.
// ============================================================================

test('twoLineTitleIndent clears the status icon and its space', () => {
	expect(twoLineTitleIndent()).toBe(2);
});

test('twoLineTitleIndent clears a 2-cell emoji prefix too', () => {
	expect(twoLineTitleIndent({emoji: '\u{1F35D}', width: 2})).toBe(5);
});

test('twoLineTitleIndent aligns with where the issue key starts', () => {
	// renderListRow lays out "<emoji> <icon> <key>"; the indent must equal the
	// offset of the key within that row.
	const prefix = {emoji: '\u{1F35D}', width: 2};
	const row = renderListRow('sta-1', '\u25CF', 'title', 40, undefined, prefix);
	expect(row.indexOf('sta-1')).toBe(twoLineTitleIndent(prefix));
});

test('twoLineTitleIndent aligns with the key when there is no emoji', () => {
	const row = renderListRow('sta-1', '\u25CF', 'title', 40);
	expect(row.indexOf('sta-1')).toBe(twoLineTitleIndent());
});

// ============================================================================
// titleSharesKeyLine — a pending row's progress text ("Starting new session…")
// has to sit beside the spinner on the first line, not on the indented title
// line below it.
// ============================================================================

test('titleSharesKeyLine: single-line layout always shares the row', () => {
	expect(titleSharesKeyLine({isTwoLine: false})).toBe(true);
	expect(titleSharesKeyLine({isTwoLine: false, isPending: true})).toBe(true);
});

test('titleSharesKeyLine: two-line layout gives real spaces their own title row', () => {
	expect(titleSharesKeyLine({isTwoLine: true})).toBe(false);
	expect(titleSharesKeyLine({isTwoLine: true, isPending: false})).toBe(false);
});

test('titleSharesKeyLine: two-line pending rows keep the text on the key line', () => {
	expect(titleSharesKeyLine({isTwoLine: true, isPending: true})).toBe(true);
});

test('the split rail never outgrows a short pane', () => {
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
					expect(
						listRows >= linesPerItem,
						`${paneRows} rows, banner ${bannerHeight}, ${agentRows} agents: ${listRows} list rows`,
					).toBe(true);
				}
			}
		}
	}
});

test('the status row gives way before the last space row', () => {
	// Two frames (4) + sous-chef (1) + one space (1) + status (1).
	expect(statusLineFits(7, 0, 1, 1)).toBe(true);
	expect(statusLineFits(6, 0, 1, 1)).toBe(false);
	expect(statusLineFits(7, 0, 1, 2)).toBe(false);
});

test('the merged rail has one frame and one status or search row', () => {
	expect(railListRows({merged: true, paneRows: 20, bannerHeight: 0})).toBe(17);
	expect(railListRows({merged: true, paneRows: 20, bannerHeight: 3})).toBe(14);
	expect(
		railListRows({
			merged: false,
			paneRows: 20,
			bannerHeight: 0,
			statusRows: 1,
			agentRows: 1,
		}),
	).toBe(14);
});

test('the stacked rail gives its status row to the list when the row has nothing to show', () => {
	// STA-3146: the workspace name and the count sit in the frame's border, so
	// an idle status row was a blank row.
	expect(
		railListRows({merged: true, paneRows: 7, bannerHeight: 0, statusRows: 0}),
	).toBe(5);
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
	expect(idle.statusFits).toBe(false);
	expect(idle.listRows).toBe(4);
	// A message or the search row takes the row back.
	const busy = railWindow(layout);
	expect(busy.statusFits).toBe(true);
	expect(busy.listRows).toBe(3);
});

// ============================================================================
// calculateRowWindow (grouped rail: one-line headers, 1- or 2-line spaces)
// ============================================================================

test('calculateRowWindow fits mixed heights within the pane', () => {
	// header, space, space, header, space, space, header, space (two-line layout)
	const heights = [1, 2, 2, 1, 2, 2, 1, 2];
	for (let cursor = 0; cursor < heights.length; cursor++) {
		const {scrollOffset, visibleCount} = calculateRowWindow(heights, cursor, 7);
		const lines = heights
			.slice(scrollOffset, scrollOffset + visibleCount)
			.reduce((sum, height) => sum + height, 0);
		expect(lines <= 7, `cursor ${cursor} overflows with ${lines} lines`).toBe(
			true,
		);
		expect(cursor >= scrollOffset && cursor < scrollOffset + visibleCount).toBe(
			true,
		);
	}
});

test('calculateRowWindow fills the pane at the end of the list', () => {
	const heights = [1, 2, 2, 1, 2, 2, 1, 2];
	expect(calculateRowWindow(heights, 7, 7)).toStrictEqual({
		scrollOffset: 4,
		visibleCount: 4,
	});
});

test('the space count shows a range only while some spaces are off screen', () => {
	expect(spaceCountLabel(1, 12, 12)).toBe('12 spaces');
	expect(spaceCountLabel(1, 1, 1)).toBe('1 space');
	expect(spaceCountLabel(4, 6, 12)).toBe('4-9 of 12');
	expect(spaceCountLabel(6, 1, 6)).toBe('6 of 6');
	expect(spaceCountLabel(1, 0, 35)).toBe('35 spaces');
	expect(spaceCountLabel(1, 0, 0)).toBe(undefined);
});

test('the status row gives way when a group header would take the only list row', () => {
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
	expect(atTop.statusFits).toBe(false);
	expect(
		rows.slice(atTop.scrollOffset, atTop.scrollOffset + atTop.visibleCount),
	).toStrictEqual(rows.slice(0, 2));
	// Cursor deep in the list: the header has scrolled out, so the status row stays.
	const deep = railWindow({...layout, cursorRow: 6, linesPerItem: 2});
	expect(deep.statusFits).toBe(true);
	expect(deep.listRows).toBe(2);
	expect(deep.scrollOffset).toBe(6);
});
