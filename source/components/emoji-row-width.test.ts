import {test, expect} from 'bun:test';
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

test('a picker row never renders wider than its frame', async () => {
	for (const emoji of RAIL_EMOJI) {
		expect(
			stringWidth(await renderPickerRow(emoji, 'Fanx AI')),
			`${emoji || '(blank slot)'} row overflowed its frame`,
		).toBe(BOX_WIDTH);
	}
});

test('the label lands in the same column for every emoji', async () => {
	const columns = new Set<number>();
	for (const emoji of RAIL_EMOJI) {
		const line = await renderPickerRow(emoji, 'Fanx AI');
		expect(line).toContain('Fanx AI');
		columns.add(stringWidth(line.slice(0, line.indexOf('Fanx AI'))));
	}

	expect(columns.size, `labels drifted across columns: ${[...columns]}`).toBe(
		1,
	);
});

test('a row with no emoji configured at all is untouched', async () => {
	// `undefined` means nobody in the config set an emoji — there is no slot, and
	// the row must render exactly as it did before emoji existed.
	const line = await renderPickerRow(undefined, 'Fanx AI');
	expect(stringWidth(line)).toBe(BOX_WIDTH);
	expect(line.startsWith('│❯ Fanx AI')).toBe(true);
});
