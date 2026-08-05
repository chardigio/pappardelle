/**
 * STA-1837 regression for a stale-layout bug that only appears on a *transition*.
 *
 * `TitledBox` draws its own top rule and passes `borderTop={false}` to the Ink
 * `<Box>` beneath it. Ink's `applyBorderStyles` guards its top-edge reset:
 *
 *     if (style.borderTop !== false) node.setBorder(Yoga.EDGE_TOP, borderWidth)
 *
 * so for this box `setBorder(EDGE_TOP, …)` is never called on restyle. Change
 * `borderStyle` on the surviving Yoga node — which is exactly what the
 * new-session dialog does when focus moves between its two frames — and the node
 * keeps a stale 1-cell top inset. It paints as a blank row wedged between the
 * hand-drawn top rule and the first child.
 *
 * Every static render passes, which is why this needs a real re-render to catch.
 * `TitledBox` remounts the inner box via `key={borderStyle}` to sidestep it.
 *
 * ava runs under `--experimental-strip-types`, which can't transform the JSX in
 * `TitledBox.tsx`, so (like `space-list-item-emoji.test.ts`) this mirrors the
 * component's structure through real Ink rather than importing it.
 */
import test from 'ava';
import React from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
import {buildTitledBorderTop} from './titled-border.ts';

const WIDTH = 40;

/** Mirror of TitledBox: hand-drawn top rule + a top-border-less bordered box. */
function mirror(borderStyle: 'double' | 'round', remount: boolean) {
	const {prefix, label, suffix} = buildTitledBorderTop(
		'Profile',
		WIDTH,
		borderStyle,
	);
	return React.createElement(
		Box,
		{flexDirection: 'column', width: WIDTH},
		React.createElement(
			Box,
			{flexDirection: 'row', width: WIDTH, key: 'top'},
			React.createElement(Text, null, prefix),
			React.createElement(Text, null, label),
			React.createElement(Text, null, suffix),
		),
		React.createElement(
			Box,
			{
				key: remount ? borderStyle : 'body',
				flexDirection: 'column',
				width: WIDTH,
				borderStyle,
				borderTop: false,
				paddingX: 2,
				paddingY: 0,
			},
			React.createElement(Text, null, 'row one'),
		),
	);
}

/** Rows between the top rule and the first content row. Should always be zero. */
function blankRowsAfterRule(frame: string): number {
	const lines = frame.split('\n');
	const ruleIndex = lines.findIndex(line => line.includes('Profile'));
	let blanks = 0;
	for (let i = ruleIndex + 1; i < lines.length; i++) {
		if (lines[i]!.includes('row one')) break;
		blanks++;
	}
	return blanks;
}

test('a freshly mounted box has no gap under its title rule, in either style', t => {
	for (const style of ['round', 'double'] as const) {
		const {lastFrame} = render(mirror(style, true));
		t.is(blankRowsAfterRule(lastFrame() ?? ''), 0, `${style} style`);
	}
});

test('restyling a remounted box leaves no stale top inset', t => {
	const {rerender, lastFrame} = render(mirror('round', true));
	t.is(blankRowsAfterRule(lastFrame() ?? ''), 0);
	rerender(mirror('double', true));
	t.is(blankRowsAfterRule(lastFrame() ?? ''), 0);
	// …and back again, so neither direction of the flip regresses.
	rerender(mirror('round', true));
	t.is(blankRowsAfterRule(lastFrame() ?? ''), 0);
});

test('bug-reproduces-without-remount: restyling a persistent node strands a blank row', t => {
	// Pins the Ink behavior the `key` works around. If a future Ink release fixes
	// `applyBorderStyles`, this flips and the remount can be dropped.
	const {rerender, lastFrame} = render(mirror('round', false));
	t.is(blankRowsAfterRule(lastFrame() ?? ''), 0);
	rerender(mirror('double', false));
	t.is(blankRowsAfterRule(lastFrame() ?? ''), 1);
});
