import test from 'ava';
import {displayWidth, POPUP_WIDTH_METHOD} from '../text-measure.ts';
import {toViewerLines} from './text-viewer-lines.ts';

test('long lines wrap to the width instead of being cut off', t => {
	t.deepEqual(toViewerLines('Created: 2026-10-08 · Updated: 2026-10-08', 20), [
		'Created: 2026-10-08',
		'· Updated:',
		'2026-10-08',
	]);
});

test('trailing blank lines and padding are dropped so G lands on content', t => {
	t.deepEqual(toViewerLines('title   \n\nbody  \n\n\n', 40), [
		'title',
		'',
		'body',
	]);
});

test('indentation survives wrapping', t => {
	t.deepEqual(toViewerLines('  indented', 40), ['  indented']);
});

test('hard wrap never splits an emoji grapheme', t => {
	for (const emoji of ['👨‍👩‍👧', '👍🏽', '🇺🇸']) {
		for (const width of [6, 7, 8, 9]) {
			const rows = toViewerLines(`abcdefg${emoji}hijklmnop`, width);
			t.true(
				rows.some(row => row.includes(emoji)),
				`${emoji} at width ${width}: ${JSON.stringify(rows)}`,
			);
		}
	}
});

test('a tab never pushes a row past the popup width', t => {
	const rows = toViewerLines('step\tbbbbbbbbbbbb ccc dd', 10);
	for (const row of rows) {
		t.true(
			displayWidth(row, POPUP_WIDTH_METHOD) <= 10,
			`${JSON.stringify(row)} overflows`,
		);
	}
});
