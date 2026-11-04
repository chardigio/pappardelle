import test from 'ava';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
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
async function renderPickerRow(
	rawEmoji: string | undefined,
	label: string,
): Promise<string> {
	const slot = resolveEmojiSlot(rawEmoji);
	const view = await render(
		React.createElement(
			'box',
			{
				flexDirection: 'column',
				border: true,
				borderStyle: 'rounded',
				width: BOX_WIDTH,
			},
			React.createElement(
				'box',
				{flexDirection: 'row'},
				React.createElement('text', null, '❯ '),
				slot ? React.createElement('text', null, slot.text) : null,
				slot?.needsSeparator ? React.createElement('text', null, ' ') : null,
				React.createElement('text', null, label),
			),
		),
	);
	const frame = view.lastFrame();
	await view.unmount();
	return frame.split('\n')[1] ?? '';
}

test('a picker row never renders wider than its frame', async t => {
	for (const emoji of RAIL_EMOJI) {
		t.is(
			stringWidth(await renderPickerRow(emoji, 'Fanx AI')),
			BOX_WIDTH,
			`${emoji || '(blank slot)'} row overflowed its frame`,
		);
	}
});

test('the label lands in the same column for every emoji', async t => {
	const columns = new Set(
		await Promise.all(
			RAIL_EMOJI.map(async emoji => {
				const line = await renderPickerRow(emoji, 'Fanx AI');
				return stringWidth(line.slice(0, line.indexOf('Fanx AI')));
			}),
		),
	);
	t.is(columns.size, 1, `labels drifted across columns: ${[...columns]}`);
});

test('a row with no emoji configured at all is untouched', async t => {
	// `undefined` means nobody in the config set an emoji — there is no slot, and
	// the row must render exactly as it did before emoji existed.
	const line = await renderPickerRow(undefined, 'Fanx AI');
	t.is(stringWidth(line), BOX_WIDTH);
	t.true(line.startsWith('│❯ Fanx AI'));
});
