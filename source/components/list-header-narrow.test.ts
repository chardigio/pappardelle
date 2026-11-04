/**
 * STA-2040 regression: the list header must stay exactly one row.
 *
 * `LIST_CHROME_ROWS` is 2 (header + status line), and `calculateListClickRow`
 * turns a mouse y into a row index on that assumption. Once the ticket rail can
 * be dragged down to a handful of columns, the header no longer fits on one
 * row. A wrapped header pushes every list row down, so clicks land on the wrong
 * space and the visible-item count is wrong too.
 *
 * ava runs under Node's `--experimental-strip-types`, which cannot transform the
 * JSX in `app.tsx`, so (like `space-list-item-emoji.test.ts`) this mirrors the
 * header markup through real Ink instead of importing the component. The
 * `bug-reproduces-without-the-fix` test pins the Ink behavior the fix depends
 * on, so an Ink drift flips it.
 */
import test from 'ava';
import {textAttributes, terminalColor} from '../tui-style.ts';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import {HEADER_ROWS} from '../list-view-sizing.ts';

const REPO = 'stardust-labs';
const SPACE_COUNT = 12;
const ERROR_COUNT = 3;

/**
 * The header's segments, exactly as app.tsx orders them: repo name, separator,
 * space count, separator, error count. `fixed` applies the two props the fix
 * adds, so the same markup can be rendered with and without it.
 */
function segments(fixed: boolean): React.ReactElement[] {
	const wrap = fixed ? ({wrapMode: 'none', truncate: true} as const) : {};
	return [
		React.createElement(
			'text',
			{
				key: 'repo',
				attributes: textAttributes({bold: true}),
				fg: terminalColor('cyan'),
				...wrap,
			},
			`\u{1F35D} ${REPO}`,
		),
		React.createElement(
			'text',
			{key: 'sep1', attributes: textAttributes({dim: true}), ...wrap},
			' | ',
		),
		React.createElement(
			'text',
			{key: 'count', attributes: textAttributes({dim: true}), ...wrap},
			`${SPACE_COUNT} spaces`,
		),
		React.createElement(
			'text',
			{key: 'sep2', attributes: textAttributes({dim: true}), ...wrap},
			' | ',
		),
		React.createElement(
			'text',
			{key: 'err', fg: terminalColor('red'), ...wrap},
			`✗ ${ERROR_COUNT}`,
		),
		React.createElement(
			'text',
			{key: 'errlabel', attributes: textAttributes({dim: true}), ...wrap},
			' (e)',
		),
	];
}

/** Render the header at `width` columns and return its lines. */
async function headerLines(width: number, fixed: boolean): Promise<string[]> {
	const children = segments(fixed);
	const header = fixed
		? React.createElement(
				'box',
				{flexDirection: 'row', height: 1, overflow: 'hidden'},
				React.createElement(
					'box',
					{flexDirection: 'row', flexShrink: 0},
					...children,
				),
			)
		: React.createElement('box', {flexDirection: 'row'}, ...children);
	const view = await render(
		React.createElement('box', {flexDirection: 'row', width}, header),
	);
	const frame = view.lastFrame();
	await view.unmount();
	return frame.replace(/\n+$/, '').split('\n');
}

const FULL = `\u{1F35D} ${REPO} | ${SPACE_COUNT} spaces | ✗ ${ERROR_COUNT} (e)`;

test('bug reproduces without the fix: a narrow header wraps onto extra rows', async t => {
	const lines = await headerLines(8, false);
	t.true(lines.length > HEADER_ROWS);
});

test('the header stays one row at every rail width a drag can reach', async t => {
	// 8 is MIN_RAIL_OVERRIDE_WIDTH, the narrowest a hand-drag may produce.
	for (const width of [8, 10, 12, 16, 20, 30, 37]) {
		const lines = await headerLines(width, true);
		t.is(lines.length, 1, `width ${width}`);
	}
});

test('a narrow header keeps its leading segment', async t => {
	const lines = await headerLines(8, true);
	t.true(lines[0]?.startsWith('\u{1F35D} '));
});

test('the header is unchanged at ordinary widths', async t => {
	// The full header is 38 cells wide, so 40 is the first width that fits it.
	for (const width of [40, 60, 120]) {
		t.deepEqual(await headerLines(width, true), [FULL], `width ${width}`);
		t.deepEqual(
			await headerLines(width, false),
			[FULL],
			`width ${width} unfixed`,
		);
	}
});

// ============================================================================
// The status line in search mode
// ============================================================================

/**
 * The search branch of the status line, mirrored from app.tsx. `TextInput`
 * cannot render under ink-testing-library (it calls `stdin.ref`), so a plain
 * Text of the same content stands in for it: what is under test is the box and
 * wrap props around it, not the input widget.
 *
 * Each segment sits in its own `flexShrink={0}` box because Ink drops a
 * one-cell Text outright when a sibling Text is truncated, which swallowed the
 * `/` prefix when the segments were bare Texts.
 */
async function searchLines(width: number, fixed: boolean): Promise<string[]> {
	const wrap = fixed ? ({wrapMode: 'none', truncate: true} as const) : {};
	const children = [
		React.createElement(
			'text',
			{key: 'slash', fg: terminalColor('cyan'), ...wrap},
			'/',
		),
		React.createElement(
			'text',
			{key: 'input', ...wrap},
			'filter by key or title...',
		),
		React.createElement(
			'text',
			{key: 'matches', attributes: textAttributes({dim: true}), ...wrap},
			' (3 matches)',
		),
	];
	const inner = fixed
		? React.createElement(
				'box',
				{flexDirection: 'row', flexShrink: 0},
				...children.map((child, index) =>
					React.createElement(
						'box',
						{flexDirection: 'row', key: index, flexShrink: 0},
						child,
					),
				),
			)
		: React.createElement(React.Fragment, null, ...children);
	const line = React.createElement(
		'box',
		{flexDirection: 'row', height: 1, overflow: 'hidden'},
		inner,
	);
	const view = await render(
		React.createElement('box', {flexDirection: 'row', width}, line),
	);
	const frame = view.lastFrame();
	await view.unmount();
	return frame.replace(/\n+$/, '').split('\n');
}

test('the search line stays one row at every rail width a drag can reach', async t => {
	for (const width of [8, 10, 12, 16, 20, 30, 37]) {
		const lines = await searchLines(width, true);
		t.is(lines.length, 1, `width ${width}`);
	}
});

test('the search line is unchanged at ordinary widths', async t => {
	const full = '/filter by key or title... (3 matches)';
	for (const width of [40, 60, 120]) {
		t.deepEqual(await searchLines(width, true), [full], `width ${width}`);
		t.deepEqual(
			await searchLines(width, false),
			[full],
			`width ${width} unfixed`,
		);
	}
});
