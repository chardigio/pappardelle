/**
 * STA-1861 regression: a profile emoji must never make its row wider than the
 * box that contains it.
 *
 * The profile picker stacks one `<Box>` per profile inside a bordered frame.
 * With a bare emoji-presentation symbol (✨ ⭐ ✅ ☕ …) Ink's writer advanced a
 * single column while its layout had reserved two, leaving a literal space
 * sitting in the cell it skipped. The terminal still paints the glyph two
 * columns wide, so that leftover space made the emitted line one column wider
 * than the frame — enough to wrap the closing border onto a line of its own,
 * which reads as a stray blank row under the offending profile.
 *
 * These tests measure the rendered line the way a terminal does (`string-width`)
 * rather than the way Ink's buffer counts characters, because the whole bug is
 * the disagreement between those two. They render through real Ink so an
 * Ink/tokenizer upgrade that changes the writer's rule flips them.
 * `string-width` stands in for the terminal everywhere except the text-
 * presentation defaults — see `TEXT_PRESENTATION_EMOJI`.
 *
 * ava runs under `--experimental-strip-types`, which can't transform JSX, so the
 * picker row is mirrored with `React.createElement` here (same approach as
 * `space-list-item-emoji.test.ts`) — it is a faithful copy of `ProfilePicker`'s
 * row: caret, emoji slot, conditional separator, label.
 */
import test from 'ava';
import React from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
import stringWidth from 'string-width';
import widestLine from 'widest-line';
import {
	inkRenderWidth,
	normalizeRailEmoji,
	resolveEmojiSlot,
} from '../emoji-rail-width.ts';

const BOX_WIDTH = 40;

/**
 * Every emoji configured across the repo's own profiles, plus the bare-BMP
 * symbols that triggered the bug and the blank slot.
 */
const RAIL_EMOJI = [
	'✨',
	'⭐',
	'✅',
	'⚡',
	'☕',
	'⏰',
	'⌚',
	'❤️',
	'⚙️',
	'🖲️',
	'🍝',
	'🐝',
	'🎸',
	'🤠',
	'📊',
	'🛒',
	'🐎',
	'💿',
	'🪲',
	'📍',
	'🏃',
	'🧩',
	'🤰',
	'🥗',
	'👨‍🍳',
	'👍🏽',
	'',
];

/**
 * Text-presentation defaults, held apart on purpose. Ink lays them out at one
 * cell and writes one, so they were never the overflow case — and a real tmux
 * pane paints them one cell wide too, which the STA-1861 QA confirmed. They're
 * separate here only because `string-width` (this file's stand-in for the
 * terminal) is the one library that disagrees, calling them two cells; measuring
 * their rows with it would report an overflow that doesn't exist.
 */
const TEXT_PRESENTATION_EMOJI = ['❤', '✂'];

/**
 * Mirror of `ProfilePicker`'s row inside a bordered frame of a known width.
 * Returns the rendered content line, ANSI-free (no styling is applied, so
 * `lastFrame()` is already plain text).
 */
function renderPickerRow(rawEmoji: string | undefined, label: string): string {
	const slot = resolveEmojiSlot(rawEmoji);
	const frame =
		render(
			React.createElement(
				Box,
				{flexDirection: 'column', borderStyle: 'round', width: BOX_WIDTH},
				React.createElement(
					Box,
					null,
					React.createElement(Text, null, '❯ '),
					slot ? React.createElement(Text, null, slot.text) : null,
					slot?.needsSeparator ? React.createElement(Text, null, ' ') : null,
					React.createElement(Text, null, label),
				),
			),
		).lastFrame() ?? '';
	return frame.split('\n')[1] ?? '';
}

test('a picker row never renders wider than its frame', t => {
	for (const emoji of RAIL_EMOJI) {
		t.is(
			stringWidth(renderPickerRow(emoji, 'Fanx AI')),
			BOX_WIDTH,
			`${emoji || '(blank slot)'} row overflowed its frame`,
		);
	}
});

test('the label lands in the same column for every emoji', t => {
	const columns = new Set(
		RAIL_EMOJI.map(emoji => {
			const line = renderPickerRow(emoji, 'Fanx AI');
			return stringWidth(line.slice(0, line.indexOf('Fanx AI')));
		}),
	);
	t.is(columns.size, 1, `labels drifted across columns: ${[...columns]}`);
});

test('a row with no emoji configured at all is untouched', t => {
	// `undefined` means nobody in the config set an emoji — there is no slot, and
	// the row must render exactly as it did before emoji existed.
	const line = renderPickerRow(undefined, 'Fanx AI');
	t.is(stringWidth(line), BOX_WIDTH);
	t.true(line.startsWith('│❯ Fanx AI'));
});

test('normalizeRailEmoji only touches glyphs Ink pads', t => {
	// Bare emoji-presentation symbols gain the variation selector…
	for (const emoji of ['✨', '⭐', '✅', '⚡', '☕', '⏰', '⌚']) {
		t.is(normalizeRailEmoji(emoji), emoji + '️', `${emoji} should be widened`);
	}

	// …everything Ink already writes at (or past) its layout width is returned
	// as-is — including the text-presentation defaults, whose glyph must not be
	// swapped out from under a user who picked it deliberately.
	for (const emoji of [
		'🍝',
		'⚙️',
		'❤️',
		'🖲️',
		'👨‍🍳',
		'👍🏽',
		...TEXT_PRESENTATION_EMOJI,
		'  ',
		'',
	]) {
		t.is(
			normalizeRailEmoji(emoji),
			emoji,
			`${emoji || '(empty)'} should be left alone`,
		);
	}
});

test('normalization makes Ink write every rail emoji at its full layout width', t => {
	for (const emoji of [...RAIL_EMOJI, ...TEXT_PRESENTATION_EMOJI].filter(
		Boolean,
	)) {
		// Ink's own layout measure is what a real terminal agreed with in the QA
		// pane, so it's the yardstick for "columns this glyph occupies". Sequences
		// Ink over-writes (flags, ZWJ) are allowed to stay wider — what must never
		// survive is Ink writing *narrower* than the row it laid out.
		t.true(
			inkRenderWidth(normalizeRailEmoji(emoji)) >= widestLine(emoji),
			`${emoji} still under-written by Ink`,
		);
	}
});

test('resolveEmojiSlot reports no overflow once normalized', t => {
	for (const emoji of [...RAIL_EMOJI, ...TEXT_PRESENTATION_EMOJI]) {
		t.is(
			resolveEmojiSlot(emoji)?.overflowCells,
			0,
			`${emoji || '(blank slot)'} still overflows`,
		);
	}

	t.is(resolveEmojiSlot(undefined), null);
});
