/**
 * STA-1539 regression: the list view's root container must be given a concrete
 * terminal height, not `height="100%"`. The full root-cause narrative lives at
 * the fix site (app.tsx, the root `<Box height={termHeight}>`); these tests pin
 * the two Ink behaviors that decision hinges on — a numeric height pads the frame
 * to full height (keeping Ink on its clean full-repaint path), while a content-
 * sized root collapses (the condition that stranded stale rows). End-to-end proof
 * is the QA-harness before/after capture on the PR (see qa-tui.md).
 */
import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {Box, Text} from 'ink';

/**
 * Mirror of app.tsx's root: a flex-column box (header + search line + a *short*
 * filtered list) — the exact shape that strands stale rows when it doesn't fill
 * the screen. `height` is the only variable under test.
 */
const listViewRoot = (height: number | string | undefined) =>
	React.createElement(
		Box,
		{flexDirection: 'column', height: height as number},
		React.createElement(
			Box,
			null,
			React.createElement(Text, null, '🍝 repo | 54 spaces'),
		),
		React.createElement(
			Box,
			null,
			React.createElement(Text, null, '/ma  (2 matches)'),
		),
		React.createElement(
			Box,
			{flexDirection: 'column'},
			React.createElement(Text, null, '● main'),
			React.createElement(Text, null, '? STA-150 Add waiting animation'),
		),
	);

const frameLineCount = (height: number | string | undefined): number => {
	const {lastFrame} = render(listViewRoot(height));
	return lastFrame()!.split('\n').length;
};

const TERM_HEIGHT = 30;

test('STA-1539: numeric terminal height pads the frame to full height (keeps Ink on the full-repaint path)', t => {
	// With a concrete height, Ink emits exactly TERM_HEIGHT rows (short content +
	// blank filler), so outputHeight === stdout.rows and every paint is a clean
	// full-screen repaint — no stale rows can survive a filter.
	t.is(frameLineCount(TERM_HEIGHT), TERM_HEIGHT);
});

test('STA-1539 regression: height="100%" collapses to content height (the condition that stranded stale rows)', t => {
	// This is the pre-fix root. The frame is only as tall as its content, which is
	// what dropped Ink onto the fragile log-update path after the zoom resize.
	t.true(frameLineCount('100%') < TERM_HEIGHT);
});

test('STA-1539 regression: a content-sized root (no height) also collapses', t => {
	t.true(frameLineCount(undefined) < TERM_HEIGHT);
});
