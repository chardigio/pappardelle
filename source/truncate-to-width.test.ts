/**
 * STA-1565 follow-up: the ticket-rail title must be truncated by *display width*
 * (the way Ink lays it out), not by UTF-16 code units. The old
 * `title.slice(0, n)` counted a ✨ (U+2728) as one code unit while Ink sizes its
 * box at two cells, so a kept ✨ pushed the title one column past its budget and
 * shoved the right-aligned rail icons out of alignment. These tests pin that the
 * truncated title never exceeds its cell budget — for plain text and for the
 * emoji classes that tripped the old slice.
 */
import test from 'ava';
import widestLine from 'widest-line';
import {truncateToWidth} from './truncate-to-width.ts';

test('short text is returned unchanged', t => {
	t.is(truncateToWidth('Migrate the VPC', 40), 'Migrate the VPC');
});

test('plain text longer than the budget is sliced and ellipsised to fit', t => {
	const out = truncateToWidth('Migrate the VPC and RDS now', 12);
	t.is(out, 'Migrate the…');
	t.is(widestLine(out), 12);
});

test('a ✨ in the title no longer overflows the budget (the regression)', t => {
	const budget = 12;
	const out = truncateToWidth('✨ Migrate the VPC and RDS now', budget);
	// The old `title.slice(0, budget - 1) + '…'` produced "✨ Migrate t…",
	// whose layout width is 13 — one cell over the 12-cell budget.
	t.true(
		widestLine(out) <= budget,
		`"${out}" is ${widestLine(out)} cells, must be <= ${budget}`,
	);
});

test('every kept ✨ counts as two cells, never overflowing', t => {
	for (const budget of [4, 7, 10, 15, 20]) {
		for (const title of [
			'✨ sparkle at the front',
			'make it ✨ sparkle ✨ now',
			'✨✨✨✨ all sparkles ✨✨✨✨',
		]) {
			const out = truncateToWidth(title, budget);
			t.true(
				widestLine(out) <= budget,
				`budget ${budget}, title "${title}" -> "${out}" (${widestLine(
					out,
				)} cells)`,
			);
		}
	}
});

test('astral and VS16 emoji are measured/cut as whole graphemes', t => {
	// 🍝 is a surrogate pair (2 code units); ⚙️ is base + VS16 (2 code points).
	// Both must be counted as their full cell width and never split.
	for (const title of ['🍝 pasta night out', '⚙️ settings and config']) {
		const out = truncateToWidth(title, 8);
		t.true(widestLine(out) <= 8, `"${out}" is ${widestLine(out)} cells`);
		// No lone surrogate / dangling combining mark left at the cut.
		t.notRegex(out.replace(/…$/, ''), /[\uD800-\uDBFF]$/, 'no split surrogate');
	}
});

test('a non-positive budget yields an empty string', t => {
	t.is(truncateToWidth('anything', 0), '');
	t.is(truncateToWidth('anything', -5), '');
});

test('exact-fit text is not truncated', t => {
	t.is(truncateToWidth('123456', 6), '123456');
});
