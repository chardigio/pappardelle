import test from 'ava';
import {
	clipErrorText,
	MAX_ERROR_CHARS,
	MAX_ERROR_LINES,
} from './clip-error-text.ts';

test('returns text unchanged when under both caps', t => {
	const result = clipErrorText('one line, short');
	t.is(result.text, 'one line, short');
	t.false(result.truncated);
});

test(`keeps the last ${MAX_ERROR_LINES} lines when more lines are present`, t => {
	const text = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
	const result = clipErrorText(text);
	t.true(result.truncated);
	const lines = result.text.split('\n');
	t.is(lines.length, MAX_ERROR_LINES);
	// The most recent lines win — earliest of the kept set is line3
	t.is(lines[0], 'line3');
	t.is(lines.at(-1), 'line5');
});

test('truncates by character cap when a single line is too long', t => {
	const text = 'x'.repeat(MAX_ERROR_CHARS + 50);
	const result = clipErrorText(text);
	t.true(result.truncated);
	t.true(result.text.length <= MAX_ERROR_CHARS);
});

test('marks character-cap truncation with a leading ellipsis', t => {
	const text = 'x'.repeat(MAX_ERROR_CHARS + 50);
	const result = clipErrorText(text);
	t.true(result.text.startsWith('…'));
});

test('returns empty string and not-truncated for empty input', t => {
	const result = clipErrorText('');
	t.is(result.text, '');
	t.false(result.truncated);
});

test(`exactly ${MAX_ERROR_LINES} short lines is not truncated`, t => {
	const text = Array.from({length: MAX_ERROR_LINES}, (_, i) => `line${i}`).join(
		'\n',
	);
	const result = clipErrorText(text);
	t.false(result.truncated);
	t.is(result.text, text);
});
