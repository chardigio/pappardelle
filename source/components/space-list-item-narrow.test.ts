import {test, expect} from 'bun:test';
import React from 'react';
import {TextAttributes} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import stringWidth from 'string-width';
import SpaceListItem from './SpaceListItem.tsx';
import type {RailStatus, SpaceData} from '../types.ts';
import type {ListLayout} from '../config.ts';

const ISSUE_KEY = 'pappardelle-akv';
const TITLE = 'Workspace sidebar rows render no title';
const space: SpaceData = {
	name: ISSUE_KEY,
	worktreePath: null,
	profileEmoji: '🍝',
	programStatus: {status: 'idle'},
	linearIssue: {
		identifier: ISSUE_KEY,
		title: TITLE,
		state: {name: 'Open', type: 'unstarted', color: '#00ff00'},
	},
	railStatus: {
		pipeline: 'passing',
		unresolvedCommentCount: 3,
		hasConflict: false,
	},
};

async function renderRow({
	laidOutWidth,
	renderWidth,
	layout = 'single_line',
	isSelected = false,
}: {
	laidOutWidth: number;
	renderWidth: number;
	layout?: ListLayout;
	isSelected?: boolean;
}): Promise<string> {
	const view = await render(
		React.createElement(
			'box',
			{flexDirection: 'row', width: renderWidth},
			React.createElement(SpaceListItem, {
				space,
				isSelected,
				width: laidOutWidth,
				layout,
			}),
		),
	);
	const frame = view.lastFrame() ?? '';
	await view.unmount();
	return frame;
}

test('the identity and title survive stale pane widths, including selection', async () => {
	for (const isSelected of [false, true]) {
		for (let laidOutWidth = 40; laidOutWidth <= 120; laidOutWidth += 10) {
			const row = await renderRow({laidOutWidth, renderWidth: 40, isSelected});
			expect(row.includes(`🍝 ● ${ISSUE_KEY} `), `Rendered row: ${row}`).toBe(
				true,
			);
			expect(row.includes('Workspace'), `Rendered row: ${row}`).toBe(true);
			expect(row.split('\n').length, `Rendered row: ${row}`).toBe(1);
		}
	}
});

test('rows stay within the pane and retain their layout height', async () => {
	for (const layout of ['single_line', 'two_line'] as const) {
		for (const renderWidth of [16, 20, 24, 30, 40]) {
			for (const laidOutWidth of [renderWidth, 60, 90, 120]) {
				const row = await renderRow({laidOutWidth, renderWidth, layout});
				const lines = row.split('\n');
				expect(lines.length, `Rendered row: ${row}`).toBe(
					layout === 'two_line' ? 2 : 1,
				);
				for (const line of lines) {
					expect(stringWidth(line) <= renderWidth, `Rendered row: ${row}`).toBe(
						true,
					);
				}
			}
		}
	}
});

const inverseCells = (spans: Array<{attributes: number; width: number}>) =>
	spans
		// eslint-disable-next-line no-bitwise
		.filter(span => (span.attributes & TextAttributes.INVERSE) !== 0)
		.reduce((sum, span) => sum + span.width, 0);

async function rowSpans({
	row,
	width,
	boxWidth = width,
	layout = 'single_line',
	isSelected = false,
}: {
	row: SpaceData;
	width: number;
	boxWidth?: number;
	layout?: ListLayout;
	isSelected?: boolean;
}) {
	const view = await render(
		React.createElement(
			'box',
			{flexDirection: 'column', width: boxWidth},
			React.createElement(SpaceListItem, {
				space: row,
				isSelected,
				width,
				layout,
			}),
		),
		{width: boxWidth, height: 2},
	);
	const lines = view
		.captureSpans()
		.lines.slice(0, layout === 'two_line' ? 2 : 1)
		.map(line => line.spans);
	await view.unmount();
	return lines;
}

const titles = {
	cjk: '修复工作区侧边栏标题显示问题和宽字符',
	emoji: 'Ship ✨ ⭐ and 👨‍🍳 fixes',
	ascii: TITLE,
};
const iconSets: Array<{railStatus: RailStatus; icons: string}> = [
	{
		railStatus: {
			pipeline: 'passing',
			unresolvedCommentCount: 3,
			hasConflict: false,
		},
		icons: ' (3) ✓',
	},
	{
		railStatus: {
			pipeline: 'progressing_dirty',
			unresolvedCommentCount: 12,
			hasConflict: true,
		},
		icons: ' (12) ↯ ◐◑',
	},
	{
		railStatus: {
			pipeline: 'progressing_clean',
			unresolvedCommentCount: 140,
			hasConflict: false,
		},
		icons: ' (140) ◔',
	},
	// Without an open PR the comment count and conflict mean nothing.
	{
		railStatus: {pipeline: null, unresolvedCommentCount: 5, hasConflict: true},
		icons: '',
	},
];

test('a row fills its width exactly and ends in its rail icons', async () => {
	const layouts = [24, 30, 40, 60].flatMap(width =>
		(['single_line', 'two_line'] as const).flatMap(layout =>
			[false, true].map(isSelected => ({width, layout, isSelected})),
		),
	);
	const cases = Object.values(titles).flatMap(title =>
		iconSets.flatMap(iconSet =>
			layouts.map(layout => ({title, ...iconSet, ...layout})),
		),
	);
	for (const {title, railStatus, icons, width, layout, isSelected} of cases) {
		const lines = await rowSpans({
			row: {...space, linearIssue: {...space.linearIssue!, title}, railStatus},
			width,
			layout,
			isSelected,
		});
		const label = `${title} ${icons} ${width} ${layout} selected=${isSelected}`;
		for (const spans of lines) {
			expect(
				spans.reduce((sum, span) => sum + span.width, 0),
				label,
			).toBe(width);
		}

		const keyLine = lines[0]!.map(span => span.text).join('');
		expect(keyLine.endsWith(`${icons} `), `${label}: ${keyLine}`).toBe(true);
	}
});

// The fixed left part (edge pad, 🍝, icon and the 15-cell key: 22 cells) and
// the icons (" (3) ✓" and the edge pad: 7 cells) need 29 cells, more than
// these boxes give a row laid out for a wider rail.
test('a row narrower than its laid-out width keeps its icons at the right edge', async () => {
	for (const renderWidth of [16, 20, 24, 28]) {
		for (const laidOutWidth of [60, 120]) {
			const row = await renderRow({laidOutWidth, renderWidth});
			expect(row.endsWith(' (3) ✓'), `Rendered row: ${row}`).toBe(true);
			expect(row.startsWith(' 🍝 ● pap'), `Rendered row: ${row}`).toBe(true);
		}
	}
});

test('a box wider than the laid-out width is one highlight bar to its edge', async () => {
	for (const layout of ['single_line', 'two_line'] as const) {
		const lines = await rowSpans({
			row: space,
			width: 40,
			boxWidth: 60,
			layout,
			isSelected: true,
		});
		for (const spans of lines)
			expect(inverseCells(spans), `layout ${layout}`).toBe(60);
	}
});

test('a wide title clipped mid-glyph stays inside the row and the bar', async () => {
	for (const boxWidth of [27, 28, 29, 30, 31]) {
		const [spans] = await rowSpans({
			row: {
				...space,
				linearIssue: {...space.linearIssue!, title: titles.cjk},
			},
			width: 60,
			boxWidth,
			isSelected: true,
		});
		const line = spans!.map(span => span.text).join('');
		expect(stringWidth(line) <= boxWidth, `Rendered row: ${line}`).toBe(true);
		expect(inverseCells(spans!), `Rendered row: ${line}`).toBe(boxWidth);
	}
});
