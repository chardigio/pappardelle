import test from 'ava';
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
