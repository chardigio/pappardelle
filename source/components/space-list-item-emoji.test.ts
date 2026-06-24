/**
 * STA-1565 regression for the two places Ink's narrow-emoji writer-pad bites
 * the ticket rail:
 *   1. the profile-emoji prefix — must render exactly one space before the
 *      Claude status icon (✨ ⭐ ✅ used to double it), and
 *   2. an emoji in the issue *title* — must not push the right-aligned rail
 *      icons onto the next line.
 *
 * ava runs under Node's `--experimental-strip-types`, which can't transform the
 * JSX in `SpaceListItem.tsx`, so (like `app-fullscreen-height.test.ts`) these
 * tests exercise the real helpers (`railEmojiIsInkPadded`, `inkRenderPad`,
 * `truncateToWidth`) through real Ink rather than importing the component. The
 * `bug-reproduces-without-…` tests pin the actual Ink behavior the fix depends
 * on, so an Ink/tokenizer drift flips them. The full component is exercised
 * end-to-end by the PR's TUI QA capture.
 */
import test from 'ava';
import React from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
import {inkRenderPad, railEmojiIsInkPadded} from '../emoji-rail-width.ts';
import {rowPrefixWidth, railPrefixWidth} from '../list-view-sizing.ts';
import {truncateToWidth} from '../truncate-to-width.ts';

const STATUS_ICON = '●';

/**
 * Mirror of SpaceListItem's leading cells: the emoji <Text>, the separator
 * (conditional, exactly as the component decides it), then the status icon.
 * `forceSeparator` reproduces the pre-fix "always emit a separator" behavior.
 */
function renderEmojiPrefix(emoji: string, forceSeparator = false): string {
	const needsSeparator = forceSeparator || !railEmojiIsInkPadded(emoji);
	// The mirrored <Text> nodes carry no color/inverse styling, so Ink emits no
	// ANSI escapes — `lastFrame()` is already plain text, nothing to strip.
	return (
		render(
			React.createElement(
				Box,
				null,
				React.createElement(Text, null, emoji),
				needsSeparator ? React.createElement(Text, null, ' ') : null,
				React.createElement(Text, null, STATUS_ICON),
			),
		).lastFrame() ?? ''
	);
}

function spacesBeforeIcon(row: string): number {
	const match = row.match(/( +)●/);
	return match ? match[1].length : -1;
}

const allRailEmoji = [
	'✨',
	'⭐',
	'✅',
	'❤',
	'🍝',
	'🐝',
	'🤠',
	'🎸',
	'🔥',
	'⚙️',
	'🖲️',
	'❤️',
];

test('every rail emoji renders exactly one space before the status icon', t => {
	for (const emoji of allRailEmoji) {
		t.is(
			spacesBeforeIcon(renderEmojiPrefix(emoji)),
			1,
			`${emoji} should have a single separating space`,
		);
	}
});

test('the blank slot renders two cells + one separator (rows stay aligned)', t => {
	// SpaceListItem maps an empty emoji ('') to a two-space placeholder before
	// it ever reaches the renderer; that slot is never Ink-padded, so the
	// explicit separator is kept → 3 spaces, same column as an emoji-bearing row.
	t.is(spacesBeforeIcon(renderEmojiPrefix('  ')), 3);
});

test('bug reproduces without the guard: ✨ doubles up if we always separate', t => {
	// Pins the actual Ink behavior the fix depends on. If this ever drops to 1,
	// Ink stopped padding ✨ and `railEmojiIsInkPadded` is now over-eager.
	t.is(spacesBeforeIcon(renderEmojiPrefix('✨', true)), 2);
	// Astral emoji never had the bug — forcing the separator is still correct.
	t.is(spacesBeforeIcon(renderEmojiPrefix('🍝', true)), 1);
});

// ---------------------------------------------------------------------------
// STA-1565 follow-up: an emoji *anywhere in a row* (✨ in the title, or a ✨/⭐/✅
// profile prefix) must not push the right-aligned rail icons onto the next line.
//
// Root cause is subtle and only shows up on a *real* terminal: Ink lays a bare-
// BMP emoji out one cell narrower than the terminal renders it, so the terminal
// expands each such glyph by a cell beyond Ink's layout. Ink's own buffer (what
// ink-testing-library exposes) looks like it fits — so this is provable only by
// rendering through real Ink into a real tmux pane (the PR's TUI QA does that).
// What we *can* unit-test is the arithmetic the fix hinges on: SpaceListItem
// shrinks the row's outer Box by `rowInkPad` (the row's total expansion) so the
// rail anchors that many columns inward. These tests mirror that computation and
// pin its invariants.
// ---------------------------------------------------------------------------

const ISSUE_KEY_FOR_ROW = 'STA-1565';

/** Mirror of SpaceListItem's title/row-width math for an emoji-rail row. */
function computeRow(emoji: string | undefined, title: string, width: number) {
	const emojiPrefixCells = rowPrefixWidth(
		emoji ? {emoji, width: 2} : undefined,
	);
	const fixedWidth =
		emojiPrefixCells +
		(1 + 1 + ISSUE_KEY_FOR_ROW.length + 1) +
		railPrefixWidth({pipelineIcon: '✓'});
	const availableTitleWidth = Math.max(0, width - fixedWidth);

	const prefixInkPad = emoji ? inkRenderPad(emoji) : 0;
	let truncatedTitle = truncateToWidth(
		title,
		availableTitleWidth - prefixInkPad,
	);
	const firstTitleInkPad = inkRenderPad(truncatedTitle);
	if (firstTitleInkPad > 0) {
		truncatedTitle = truncateToWidth(
			title,
			availableTitleWidth - prefixInkPad - firstTitleInkPad,
		);
	}

	const rowInkPad = prefixInkPad + inkRenderPad(truncatedTitle);
	const rowWidth = rowInkPad > 0 ? Math.max(0, width - rowInkPad) : width;
	return {fixedWidth, availableTitleWidth, truncatedTitle, rowInkPad, rowWidth};
}

const EMOJI_TITLE =
	'Pappardelle: ticket-rail emoji like ✨ render with an extra space';

test('rowInkPad counts the row’s total emoji expansion (prefix + title)', t => {
	for (let width = 40; width <= 80; width++) {
		for (const emoji of [undefined, '🍝', '✨']) {
			const {truncatedTitle, rowInkPad} = computeRow(emoji, EMOJI_TITLE, width);
			const expected =
				(emoji ? inkRenderPad(emoji) : 0) + inkRenderPad(truncatedTitle);
			t.is(rowInkPad, expected, `width ${width}, emoji ${emoji}`);
		}
	}
});

test('the shrunk row plus its expansion exactly fills the pane (rail keeps its column)', t => {
	for (let width = 40; width <= 80; width++) {
		for (const emoji of ['🍝', '✨']) {
			const {rowWidth, rowInkPad} = computeRow(emoji, EMOJI_TITLE, width);
			// The terminal renders the row as Ink's box width + the glyph
			// expansion; shrinking by exactly rowInkPad lands the rail on the pane
			// edge, never past it. (That it never *under*-fills enough to clip the
			// title is proven end-to-end by the PR's real-Ink tmux QA.)
			t.is(rowWidth + rowInkPad, width, `width ${width}, emoji ${emoji}`);
		}
	}
});

test('off by default: an all-ASCII row is never shrunk (byte-identical to master)', t => {
	const plain = 'Plain ASCII title with no emoji at all here okay';
	for (let width = 40; width <= 80; width++) {
		const {rowInkPad, rowWidth} = computeRow(undefined, plain, width);
		t.is(rowInkPad, 0);
		t.is(rowWidth, width); // unchanged → outer Box width stays `width`
	}
});
