import test from 'ava';
import {
	clipErrorText,
	clipLogEntryForDisplay,
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

// ----------------------------------------------------------------------------
// clipLogEntryForDisplay — guards the TUI error rail against any log call
// (existing or future) that stuffs payload into the message string. The body
// field has been clipped for a while; until now the headline was rendered
// verbatim, which let a bulk rail-status failure paint the screen with raw
// JSON. Pinning both fields here means new call sites are auto-protected.
// ----------------------------------------------------------------------------

test('clipLogEntryForDisplay: short message + no error round-trips unchanged', t => {
	const result = clipLogEntryForDisplay({message: 'Failed to fetch X'});
	t.is(result.headline.text, 'Failed to fetch X');
	t.false(result.headline.truncated);
	t.is(result.body, null);
});

test('clipLogEntryForDisplay: short message + short error preserves both', t => {
	const result = clipLogEntryForDisplay({
		message: 'Failed to fetch X',
		error: 'timeout',
	});
	t.is(result.headline.text, 'Failed to fetch X');
	t.false(result.headline.truncated);
	t.is(result.body!.text, 'timeout');
	t.false(result.body!.truncated);
});

test('clipLogEntryForDisplay: oversized message gets clipped to the same caps as error body', t => {
	const huge = 'x'.repeat(MAX_ERROR_CHARS + 500);
	const result = clipLogEntryForDisplay({message: huge});
	t.true(result.headline.truncated);
	t.true(result.headline.text.length <= MAX_ERROR_CHARS);
	t.true(result.headline.text.startsWith('…'));
});

test('clipLogEntryForDisplay: JSON-shaped message from a bulk gh failure cannot blow up the rail', t => {
	// Mirrors the failure mode in github-provider.ts when gh dumps a
	// pretty-printed GraphQL error response and a future caller forgets to
	// route it through the error parameter — the rail should still hold.
	const jsonish = JSON.stringify(
		{
			errors: Array.from({length: 30}, (_, i) => ({
				message: `Could not resolve to a Repository with the name 'whatever-${i}'.`,
				type: 'NOT_FOUND',
				path: ['repository', `pr${i}`],
			})),
		},
		null,
		2,
	);
	const result = clipLogEntryForDisplay({message: `Bulk failure: ${jsonish}`});

	t.true(result.headline.truncated);
	t.true(result.headline.text.length <= MAX_ERROR_CHARS);
	t.true(result.headline.text.split('\n').length <= MAX_ERROR_LINES);
});

test('clipLogEntryForDisplay: error field still gets clipped alongside the headline', t => {
	const big = 'y'.repeat(MAX_ERROR_CHARS + 500);
	const result = clipLogEntryForDisplay({message: 'short', error: big});
	t.false(result.headline.truncated);
	t.true(result.body!.truncated);
	t.true(result.body!.text.length <= MAX_ERROR_CHARS);
});
