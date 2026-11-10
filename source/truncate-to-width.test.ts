/**
 * STA-1565 follow-up: the ticket-rail title must be truncated by *display width*,
 * not by UTF-16 code units. The old `title.slice(0, n)` counted a ✨ (U+2728) as
 * one code unit while the renderer lays it out at two cells, so a kept ✨
 * pushed the title one column past its budget and shoved the right-aligned rail
 * icons out of alignment. These tests pin that the truncated title never
 * exceeds its cell budget, for plain text and for the emoji classes that
 * tripped the old slice.
 */
import test from 'ava';
import widestLine from 'widest-line';
import {displayWidth} from './text-measure.ts';
import {truncateRunsToWidth, truncateToWidth} from './truncate-to-width.ts';

test('short text is returned unchanged', t => {
	t.is(truncateToWidth('Migrate the VPC', 40, 'unicode'), 'Migrate the VPC');
});

test('plain text longer than the budget is sliced and ellipsised to fit', t => {
	const out = truncateToWidth('Migrate the VPC and RDS now', 12, 'unicode');
	t.is(out, 'Migrate the…');
	t.is(widestLine(out), 12);
});

test('a ✨ in the title no longer overflows the budget (the regression)', t => {
	const budget = 12;
	const out = truncateToWidth(
		'✨ Migrate the VPC and RDS now',
		budget,
		'unicode',
	);
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
			const out = truncateToWidth(title, budget, 'unicode');
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
		const out = truncateToWidth(title, 8, 'unicode');
		t.true(widestLine(out) <= 8, `"${out}" is ${widestLine(out)} cells`);
		// No lone surrogate / dangling combining mark left at the cut.
		t.notRegex(out.replace(/…$/, ''), /[\uD800-\uDBFF]$/, 'no split surrogate');
	}
});

test('a non-positive budget yields an empty string', t => {
	t.is(truncateToWidth('anything', 0, 'unicode'), '');
	t.is(truncateToWidth('anything', -5, 'unicode'), '');
});

test('exact-fit text is not truncated', t => {
	t.is(truncateToWidth('123456', 6, 'unicode'), '123456');
});

const runsText = (runs: Array<{text: string}>) =>
	runs.map(run => run.text).join('');

test('styled runs that fit are kept whole', t => {
	const runs = [
		{text: 'g   ', fg: 'yellow'},
		{text: 'Open PR', fg: undefined},
	];
	t.deepEqual(truncateRunsToWidth(runs, 11, 'unicode'), runs);
});

test('the run crossing the budget is cut, carries the ellipsis, and later runs are dropped', t => {
	const runs = [
		{text: 'g   ', fg: 'yellow'},
		{text: 'Open PR / MR in browser', fg: 'white'},
		{text: ' (custom)', fg: 'magenta'},
	];
	const out = truncateRunsToWidth(runs, 12, 'unicode');
	t.is(runsText(out), 'g   Open PR…');
	t.is(widestLine(runsText(out)), 12);
	t.deepEqual(
		out.map(run => run.fg),
		['yellow', 'white'],
	);
});

// OpenTUI draws these wider or narrower than `widest-line` counts them: a soft
// hyphen takes a cell under tmux's unicode method, a Devanagari spacing mark
// does not, and the wcwidth method used outside tmux on terminals without mode
// 2027 counts every emoji code point.
test('a soft-hyphenated title stays within the cells OpenTUI draws', t => {
	const out = truncateToWidth(
		'Re­write the con­fig mi­gra­tion',
		16,
		'unicode',
	);
	t.true(displayWidth(out, 'unicode') <= 16, `"${out}" overflows`);
});

test('Devanagari that fits as OpenTUI draws it is not cut', t => {
	t.is(truncateToWidth('किताब', 3, 'unicode'), 'किताब');
});

test('emoji are measured as wcwidth draws them outside tmux', t => {
	const out = truncateToWidth('👍🏽👨‍👩‍👧 ship it', 8, 'wcwidth');
	t.true(displayWidth(out, 'wcwidth') <= 8, `"${out}" overflows`);
});

test('styled runs stay within the cells OpenTUI draws', t => {
	const out = truncateRunsToWidth(
		[{text: 'g '}, {text: '👍🏽 ship it'}, {text: ' (custom)'}],
		10,
		'wcwidth',
	);
	t.true(
		displayWidth(runsText(out), 'wcwidth') <= 10,
		`"${runsText(out)}" overflows`,
	);
});

test('a run that ends exactly at the budget still shows that more was cut', t => {
	const out = truncateRunsToWidth(
		[{text: 'abcd'}, {text: 'efgh'}],
		4,
		'unicode',
	);
	t.is(runsText(out), 'abc…');
});
