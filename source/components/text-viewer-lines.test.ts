import {test, expect} from 'bun:test';
import {displayWidth, POPUP_WIDTH_METHOD} from '../text-measure.ts';
import {toViewerLines} from './text-viewer-lines.ts';

test('long lines wrap to the width instead of being cut off', () => {
	expect(
		toViewerLines('Created: 2026-10-08 · Updated: 2026-10-08', 20),
	).toStrictEqual(['Created: 2026-10-08', '· Updated:', '2026-10-08']);
});

test('trailing blank lines and padding are dropped so G lands on content', () => {
	expect(toViewerLines('title   \n\nbody  \n\n\n', 40)).toStrictEqual([
		'title',
		'',
		'body',
	]);
});

test('indentation survives wrapping', () => {
	expect(toViewerLines('  indented', 40)).toStrictEqual(['  indented']);
});

test('hard wrap never splits an emoji grapheme', () => {
	for (const emoji of ['👨‍👩‍👧', '👍🏽', '🇺🇸']) {
		for (const width of [6, 7, 8, 9]) {
			const rows = toViewerLines(`abcdefg${emoji}hijklmnop`, width);
			expect(
				rows.some(row => row.includes(emoji)),
				`${emoji} at width ${width}: ${JSON.stringify(rows)}`,
			).toBe(true);
		}
	}
});

test('a tab never pushes a row past the popup width', () => {
	const rows = toViewerLines('step\tbbbbbbbbbbbb ccc dd', 10);
	for (const row of rows) {
		expect(
			displayWidth(row, POPUP_WIDTH_METHOD) <= 10,
			`${JSON.stringify(row)} overflows`,
		).toBe(true);
	}
});
