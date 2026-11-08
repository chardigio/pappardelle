/**
 * STA-1539 regression: the list view's root container must fill the terminal.
 * Blank filler rows let the renderer erase stale results when a search shrinks
 * the list after zooming.
 */
import test from 'ava';
import React from 'react';
import {render} from '../test/helpers/render.ts';

/**
 * Mirror of app.tsx's root: a flex-column box (header + search line + a *short*
 * filtered list) — the exact shape that strands stale rows when it doesn't fill
 * the screen. `height` is the only variable under test.
 */
const listViewRoot = (height: number | string | undefined) =>
	React.createElement(
		'box',
		{flexDirection: 'column', height: height as number},
		React.createElement(
			'box',
			{flexDirection: 'row'},
			React.createElement('text', null, '🍝 repo | 54 spaces'),
		),
		React.createElement(
			'box',
			{flexDirection: 'row'},
			React.createElement('text', null, '/ma  (2 matches)'),
		),
		React.createElement(
			'box',
			{flexDirection: 'column'},
			React.createElement('text', null, '● main'),
			React.createElement('text', null, '? STA-150 Add waiting animation'),
		),
	);

const frameLineCount = async (
	height: number | string | undefined,
): Promise<number> => {
	const {lastFrame} = await render(listViewRoot(height));
	return lastFrame()!.split('\n').length;
};

const TERM_HEIGHT = 30;

test('STA-1539: numeric terminal height includes blank rows below the filtered list', async t => {
	t.is(await frameLineCount(TERM_HEIGHT), TERM_HEIGHT);
});

test('OpenTUI percentage height also fills the terminal', async t => {
	// Ink collapsed a 100% root to its content, which is why app.tsx passes a
	// numeric height. OpenTUI resolves it against the renderer's 80 rows.
	t.is(await frameLineCount('100%'), 80);
});

test('STA-1539 regression: a content-sized root (no height) also collapses', async t => {
	t.true((await frameLineCount(undefined)) < TERM_HEIGHT);
});
