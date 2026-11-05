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
};

const spans: SpanStyle[] = [
	{},
	{fg: 'red', bold: true},
	{dim: true},
	{fg: TEAL, bold: true},
];

const isInverse = (attributes: number) =>
	// eslint-disable-next-line no-bitwise
	(attributes & TextAttributes.INVERSE) !== 0;

test('an unselected row keeps the tracker state color on its issue key', t => {
	const key = resolveRowHighlight(base).paint({
		fg: TEAL,
		bold: true,
	});
	t.deepEqual(key.fg, terminalColor(TEAL));
	t.false(isInverse(key.attributes));
});

test('a selected row inverts its key and title against the default foreground, whatever the state color', t => {
	const row = resolveRowHighlight({...base, isSelected: true});
	for (const stateColor of [TEAL, NEAR_BACKGROUND, 'gray', 'white']) {
		for (const span of [{fg: stateColor, bold: true}, {dim: true}]) {
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

test('selection inverts every span with default colors, icons included', t => {
	const row = resolveRowHighlight({...base, isSelected: true});
	for (const span of [{fg: 'green', bold: true}, {fg: 'red'}, {}]) {
		const paint = row.paint(span);
		t.true(isInverse(paint.attributes), `span ${JSON.stringify(span)}`);
		t.deepEqual(
			paint.fg,
			RGBA.defaultForeground(),
			`span ${JSON.stringify(span)}`,
		);
	}
});

test('bright black never reaches any span on a row', t => {
	// Solarized and its descendants map ANSI 8 to the background itself, so a
	// key or icon painted 'gray' rendered background-on-background.
	const row = resolveRowHighlight(base);
	for (const fg of ['gray', 'grey', 'blackBright']) {
		for (const span of [{fg, bold: true}, {fg}]) {
			t.deepEqual(
				row.paint(span).fg,
				RGBA.defaultForeground(),
				`color ${fg}, span ${JSON.stringify(span)}`,
			);
		}
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
	const title = row.paint({dim: true});
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
