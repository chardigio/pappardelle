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
import React from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
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
	const wrap = fixed ? ({wrap: 'truncate-end'} as const) : {};
	return [
		React.createElement(
			Text,
			{key: 'repo', bold: true, color: 'cyan', ...wrap},
			`\u{1F35D} ${REPO}`,
		),
		React.createElement(Text, {key: 'sep1', dimColor: true, ...wrap}, ' | '),
		React.createElement(
			Text,
			{key: 'count', dimColor: true, ...wrap},
			`${SPACE_COUNT} spaces`,
		),
		React.createElement(Text, {key: 'sep2', dimColor: true, ...wrap}, ' | '),
		React.createElement(
			Text,
			{key: 'err', color: 'red', ...wrap},
			`✗ ${ERROR_COUNT}`,
		),
		React.createElement(
			Text,
			{key: 'errlabel', dimColor: true, ...wrap},
			' (e)',
		),
	];
}

/** Render the header at `width` columns and return its lines. */
function headerLines(width: number, fixed: boolean): string[] {
	const children = segments(fixed);
	const header = fixed
		? React.createElement(
				Box,
				{height: 1, overflowX: 'hidden'},
				React.createElement(Box, {flexShrink: 0}, ...children),
			)
		: React.createElement(Box, null, ...children);
	const {lastFrame} = render(React.createElement(Box, {width}, header));
	return (lastFrame() ?? '').replace(/\n+$/, '').split('\n');
}

const FULL = `\u{1F35D} ${REPO} | ${SPACE_COUNT} spaces | ✗ ${ERROR_COUNT} (e)`;

test('bug reproduces without the fix: a narrow header wraps onto extra rows', t => {
	t.true(headerLines(8, false).length > HEADER_ROWS);
});

test('the header stays one row at every rail width a drag can reach', t => {
	// 8 is MIN_RAIL_OVERRIDE_WIDTH, the narrowest a hand-drag may produce.
	for (const width of [8, 10, 12, 16, 20, 30, 37]) {
		t.is(headerLines(width, true).length, 1, `width ${width}`);
	}
});

test('a narrow header keeps its leading segment', t => {
	t.true(headerLines(8, true)[0]?.startsWith('\u{1F35D} '));
});

test('the header is unchanged at ordinary widths', t => {
	// The full header is 38 cells wide, so 40 is the first width that fits it.
	for (const width of [40, 60, 120]) {
		t.deepEqual(headerLines(width, true), [FULL], `width ${width}`);
		t.deepEqual(headerLines(width, false), [FULL], `width ${width} unfixed`);
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
function searchLines(width: number, fixed: boolean): string[] {
	const wrap = fixed ? ({wrap: 'truncate-end'} as const) : {};
	const children = [
		React.createElement(Text, {key: 'slash', color: 'cyan', ...wrap}, '/'),
		React.createElement(
			Text,
			{key: 'input', ...wrap},
			'filter by key or title...',
		),
		React.createElement(
			Text,
			{key: 'matches', dimColor: true, ...wrap},
			' (3 matches)',
		),
	];
	const inner = fixed
		? React.createElement(
				Box,
				{flexShrink: 0},
				...children.map((child, index) =>
					React.createElement(Box, {key: index, flexShrink: 0}, child),
				),
			)
		: React.createElement(React.Fragment, null, ...children);
	const line = React.createElement(
		Box,
		{height: 1, overflowX: 'hidden'},
		inner,
	);
	const {lastFrame} = render(React.createElement(Box, {width}, line));
	return (lastFrame() ?? '').replace(/\n+$/, '').split('\n');
}

test('the search line stays one row at every rail width a drag can reach', t => {
	for (const width of [8, 10, 12, 16, 20, 30, 37]) {
		t.is(searchLines(width, true).length, 1, `width ${width}`);
	}
});

test('bug reproduces without the fix: narrow search segments interleave', t => {
	// `height: 1` already bounds the row count, so the click hit-test was never
	// wrong here. What breaks is the content: yoga squeezes every segment at
	// once, so the line reads as fragments of all three interleaved.
	t.not(searchLines(12, false)[0], searchLines(12, true)[0]);
	t.true(searchLines(12, true)[0]?.startsWith('/filter'));
	// The unfixed line interleaves fragments of all three segments instead.
	t.false(searchLines(12, false)[0]?.startsWith('/filter'));
});

test('the search line is unchanged at ordinary widths', t => {
	const full = '/filter by key or title... (3 matches)';
	for (const width of [40, 60, 120]) {
		t.deepEqual(searchLines(width, true), [full], `width ${width}`);
		t.deepEqual(searchLines(width, false), [full], `width ${width} unfixed`);
	}
});
