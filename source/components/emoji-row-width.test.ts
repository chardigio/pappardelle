import test from 'ava';
import React from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
import stringWidth from 'string-width';
import {resolveEmojiSlot} from '../emoji-rail-width.ts';

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
