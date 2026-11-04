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
 *
 * The attention blink has the opposite failure under OpenTUI: `inverse` with an
 * explicit foreground filled the background with that same color, so a blocked
 * row's text disappeared on every blink-on frame.
 */
import test from 'ava';
import {RGBA, TextAttributes} from '@opentui/core';
import {terminalColor} from '../tui-style.ts';
import {resolveRowHighlight, type SpanStyle} from './row-highlight.ts';

const TEAL = '#26b5ce';
const NEAR_BACKGROUND = '#0b3b45';

const base = {
	isSelected: false,
	needsAttention: false,
	blinkOn: false,
	isQuestion: false,
	stateColor: TEAL,
};

const spans: SpanStyle[] = [
	{},
	{fg: 'red', bold: true},
	{dim: true},
	{fg: TEAL, bold: true, selectable: true},
	{dim: true, selectable: true},
];

const isInverse = (attributes: number) =>
	// eslint-disable-next-line no-bitwise
	(attributes & TextAttributes.INVERSE) !== 0;

test('an unselected row keeps the tracker state color on its issue key', t => {
	const row = resolveRowHighlight(base);
	t.is(row.keyColor, TEAL);
	const key = row.paint({fg: row.keyColor, bold: true, selectable: true});
	t.deepEqual(key.fg, terminalColor(TEAL));
	t.false(isInverse(key.attributes));
});

test('a selected row inverts its key and title against the default foreground, whatever the state color', t => {
	for (const stateColor of [TEAL, NEAR_BACKGROUND, 'gray', 'white']) {
		const row = resolveRowHighlight({...base, isSelected: true, stateColor});
		for (const span of [
			{fg: row.keyColor, bold: true, selectable: true},
			{dim: true, selectable: true},
		]) {
			const paint = row.paint(span);
			t.true(isInverse(paint.attributes), `state color ${stateColor}`);
			t.deepEqual(
				paint.fg,
				RGBA.defaultForeground(),
				`state color ${stateColor}`,
			);
			t.is(paint.bg, undefined, `state color ${stateColor}`);
		}
	}
});

test('selection leaves the row chrome (status icon, rail icons) in its own colors', t => {
	const row = resolveRowHighlight({...base, isSelected: true});
	const icon = row.paint({fg: 'green', bold: true});
	t.false(isInverse(icon.attributes));
	t.deepEqual(icon.fg, terminalColor('green'));
});

test('a bright-black state color never reaches the key', t => {
	// Solarized and its descendants map ANSI 8 to the background itself, so an
	// unselected key painted 'gray' rendered background-on-background and only
	// appeared once selection inverted it. Falling back to no color puts it in
	// the terminal's default foreground, which contrasts by construction.
	for (const stateColor of ['gray', 'grey', 'blackBright']) {
		t.is(
			resolveRowHighlight({...base, stateColor}).keyColor,
			undefined,
			`state color ${stateColor}`,
		);
	}
});

test('the attention blink paints every span as a colored block with readable text', t => {
	for (const [isQuestion, color] of [
		[false, 'red'],
		[true, 'blue'],
	] as const) {
		for (const isSelected of [false, true]) {
			const row = resolveRowHighlight({
				...base,
				isSelected,
				needsAttention: true,
				blinkOn: true,
				isQuestion,
			});
			for (const span of spans) {
				const paint = row.paint(span);
				const label = `${color}, selected=${isSelected}, ${JSON.stringify(span)}`;
				t.deepEqual(paint.bg, terminalColor(color), label);
				t.notDeepEqual(paint.fg, paint.bg, label);
				t.false(isInverse(paint.attributes), label);
			}
		}
	}
});

test('the blink off-phase falls back to the selection highlight', t => {
	const row = resolveRowHighlight({
		...base,
		isSelected: true,
		needsAttention: true,
		blinkOn: false,
	});
	const title = row.paint({dim: true, selectable: true});
	t.true(isInverse(title.attributes));
	t.is(title.bg, undefined);
});

test('an unselected attention row in its off-phase is not highlighted at all', t => {
	const row = resolveRowHighlight({...base, needsAttention: true});
	for (const span of spans) {
		const paint = row.paint(span);
		const label = `span ${JSON.stringify(span)}`;
		t.false(isInverse(paint.attributes), label);
		t.is(paint.bg, undefined, label);
	}
});
