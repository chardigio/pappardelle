/**
 * Regression for the two color symptoms in the narrow-sidebar bug: the selected
 * row was barely distinguishable, and its title vanished on highlight instead
 * of inverting with the rest of the row.
 *
 * Both came from the same line — the selected row painted its key and title
 * with the tracker's workflow-state color *under* `inverse`, which makes that
 * color the highlight's background and leaves the text in the terminal's
 * background color. Contrast then rode entirely on a color pappardelle doesn't
 * control.
 */
import test from 'ava';
import {resolveRowHighlight} from './row-highlight.ts';

const TEAL = '#26b5ce';
const NEAR_BACKGROUND = '#0b3b45';

const base = {
	isSelected: false,
	needsAttention: false,
	blinkOn: false,
	isQuestion: false,
	stateColor: TEAL,
};

test('an unselected row keeps the tracker state color on its issue key', t => {
	const row = resolveRowHighlight(base);
	t.false(row.useInverse);
	t.is(row.keyColor, TEAL);
	t.is(row.titleColor, undefined);
});

test('a selected row drops the state color so it inverts against the default foreground', t => {
	for (const stateColor of [TEAL, NEAR_BACKGROUND, 'gray', 'white']) {
		const row = resolveRowHighlight({...base, isSelected: true, stateColor});
		t.true(row.useSelectionInverse, `state color ${stateColor}`);
		t.is(row.keyColor, undefined, `state color ${stateColor}`);
		t.is(row.titleColor, undefined, `state color ${stateColor}`);
	}
});

test('key and title share one color on a selected row (the title cannot vanish alone)', t => {
	const row = resolveRowHighlight({...base, isSelected: true});
	t.is(row.keyColor, row.titleColor);
});

test('a state color near the terminal background can no longer set the highlight', t => {
	// The failure mode: pre-fix this returned NEAR_BACKGROUND, which inverse
	// turned into a background indistinguishable from the terminal's own.
	const row = resolveRowHighlight({
		...base,
		isSelected: true,
		stateColor: NEAR_BACKGROUND,
	});
	t.not(row.keyColor, NEAR_BACKGROUND);
});

test('a bright-black state color never reaches the key, on any row', t => {
	// Solarized and its descendants map ANSI 8 to the background itself, so an
	// unselected key painted 'gray' rendered background-on-background and only
	// appeared once selection inverted it. Falling back to no color puts it in
	// the terminal's default foreground, which contrasts by construction.
	for (const stateColor of ['gray', 'grey', 'blackBright']) {
		t.is(
			resolveRowHighlight({...base, stateColor}).keyColor,
			undefined,
			`unselected, state color ${stateColor}`,
		);
		t.is(
			resolveRowHighlight({...base, needsAttention: true, stateColor}).keyColor,
			undefined,
			`attention off-phase, state color ${stateColor}`,
		);
	}
});

test('attention blink still owns the row and outranks selection', t => {
	const approval = resolveRowHighlight({
		...base,
		isSelected: true,
		needsAttention: true,
		blinkOn: true,
	});
	t.true(approval.useBlinkInverse);
	t.false(approval.useSelectionInverse);
	t.is(approval.textColor, 'red');
	t.is(approval.keyColor, TEAL);

	const question = resolveRowHighlight({
		...base,
		needsAttention: true,
		blinkOn: true,
		isQuestion: true,
	});
	t.is(question.textColor, 'blue');
});

test('the blink off-phase falls back to the selection highlight', t => {
	const row = resolveRowHighlight({
		...base,
		isSelected: true,
		needsAttention: true,
		blinkOn: false,
	});
	t.false(row.useBlinkInverse);
	t.true(row.useSelectionInverse);
	t.true(row.useInverse);
	t.is(row.keyColor, undefined);
});

test('an unselected attention row in its off-phase is not inverted at all', t => {
	const row = resolveRowHighlight({...base, needsAttention: true});
	t.false(row.useInverse);
	t.is(row.textColor, undefined);
});
