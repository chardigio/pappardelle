import {test, expect} from 'bun:test';
import {
	clipErrorText,
	clipLogEntryForDisplay,
	MAX_ERROR_CHARS,
	MAX_ERROR_LINES,
} from './clip-error-text.ts';

test('returns text unchanged when under both caps', () => {
	const result = clipErrorText('one line, short');
	expect(result.text).toBe('one line, short');
	expect(result.truncated).toBe(false);
});

test(`keeps the last ${MAX_ERROR_LINES} lines when more lines are present`, () => {
	const text = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
	const result = clipErrorText(text);
	expect(result.truncated).toBe(true);
	const lines = result.text.split('\n');
	expect(lines.length).toBe(MAX_ERROR_LINES);
	// The most recent lines win — earliest of the kept set is line3
	expect(lines[0]).toBe('line3');
	expect(lines.at(-1)).toBe('line5');
});

test('truncates by character cap when a single line is too long', () => {
	const text = 'x'.repeat(MAX_ERROR_CHARS + 50);
	const result = clipErrorText(text);
	expect(result.truncated).toBe(true);
	expect(result.text.length <= MAX_ERROR_CHARS).toBe(true);
});

test('marks character-cap truncation with a leading ellipsis', () => {
	const text = 'x'.repeat(MAX_ERROR_CHARS + 50);
	const result = clipErrorText(text);
	expect(result.text.startsWith('…')).toBe(true);
});

test('returns empty string and not-truncated for empty input', () => {
	const result = clipErrorText('');
	expect(result.text).toBe('');
	expect(result.truncated).toBe(false);
});

test(`exactly ${MAX_ERROR_LINES} short lines is not truncated`, () => {
	const text = Array.from({length: MAX_ERROR_LINES}, (_, i) => `line${i}`).join(
		'\n',
	);
	const result = clipErrorText(text);
	expect(result.truncated).toBe(false);
	expect(result.text).toBe(text);
});

// ----------------------------------------------------------------------------
// clipLogEntryForDisplay — guards the TUI error rail against any log call
// (existing or future) that stuffs payload into the message string. The body
// field has been clipped for a while; until now the headline was rendered
// verbatim, which let a bulk rail-status failure paint the screen with raw
// JSON. Pinning both fields here means new call sites are auto-protected.
// ----------------------------------------------------------------------------

test('clipLogEntryForDisplay: short message + no error round-trips unchanged', () => {
	const result = clipLogEntryForDisplay({message: 'Failed to fetch X'});
	expect(result.headline.text).toBe('Failed to fetch X');
	expect(result.headline.truncated).toBe(false);
	expect(result.body).toBe(null);
});

test('clipLogEntryForDisplay: short message + short error preserves both', () => {
	const result = clipLogEntryForDisplay({
		message: 'Failed to fetch X',
		error: 'timeout',
	});
	expect(result.headline.text).toBe('Failed to fetch X');
	expect(result.headline.truncated).toBe(false);
	expect(result.body!.text).toBe('timeout');
	expect(result.body!.truncated).toBe(false);
});

test('clipLogEntryForDisplay: oversized message gets clipped to the same caps as error body', () => {
	const huge = 'x'.repeat(MAX_ERROR_CHARS + 500);
	const result = clipLogEntryForDisplay({message: huge});
	expect(result.headline.truncated).toBe(true);
	expect(result.headline.text.length <= MAX_ERROR_CHARS).toBe(true);
	expect(result.headline.text.startsWith('…')).toBe(true);
});

test('clipLogEntryForDisplay: JSON-shaped message from a bulk gh failure cannot blow up the rail', () => {
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

	expect(result.headline.truncated).toBe(true);
	expect(result.headline.text.length <= MAX_ERROR_CHARS).toBe(true);
	expect(result.headline.text.split('\n').length <= MAX_ERROR_LINES).toBe(true);
});

test('clipLogEntryForDisplay: error field still gets clipped alongside the headline', () => {
	const big = 'y'.repeat(MAX_ERROR_CHARS + 500);
	const result = clipLogEntryForDisplay({message: 'short', error: big});
	expect(result.headline.truncated).toBe(false);
	expect(result.body!.truncated).toBe(true);
	expect(result.body!.text.length <= MAX_ERROR_CHARS).toBe(true);
});
