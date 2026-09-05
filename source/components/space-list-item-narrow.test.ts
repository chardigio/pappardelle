import test from 'ava';
import React from 'react';
import {Box} from 'ink';
import {render} from 'ink-testing-library';
import stringWidth from 'string-width';
import SpaceListItem from './SpaceListItem.tsx';
import type {SpaceData} from '../types.ts';
import type {ListLayout} from '../config.ts';

const ISSUE_KEY = 'pappardelle-akv';
const TITLE = 'Workspace sidebar rows render no title';
const space: SpaceData = {
	name: ISSUE_KEY,
	worktreePath: null,
	profileEmoji: '🍝',
	claudeStatus: 'waiting_for_input',
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

function renderRow({
	laidOutWidth,
	renderWidth,
	layout = 'single_line',
	isSelected = false,
}: {
	laidOutWidth: number;
	renderWidth: number;
	layout?: ListLayout;
	isSelected?: boolean;
}): string {
	const view = render(
		React.createElement(
			Box,
			{width: renderWidth},
			React.createElement(SpaceListItem, {
				space,
				isSelected,
				width: laidOutWidth,
				layout,
			}),
		),
	);
	const frame = view.lastFrame() ?? '';
	view.unmount();
	return frame;
}

test('the identity and title survive stale pane widths, including selection', t => {
	for (const isSelected of [false, true]) {
		for (let laidOutWidth = 40; laidOutWidth <= 120; laidOutWidth += 10) {
			const row = renderRow({laidOutWidth, renderWidth: 40, isSelected});
			t.true(row.includes(`🍝 ● ${ISSUE_KEY} `), `Rendered row: ${row}`);
			t.true(row.includes('Workspace'), `Rendered row: ${row}`);
			t.is(row.split('\n').length, 1, `Rendered row: ${row}`);
		}
	}
});

test('rows stay within the pane and retain their layout height', t => {
	for (const layout of ['single_line', 'two_line'] as const) {
		for (const renderWidth of [16, 20, 24, 30, 40]) {
			for (const laidOutWidth of [renderWidth, 60, 90, 120]) {
				const row = renderRow({laidOutWidth, renderWidth, layout});
				const lines = row.split('\n');
				t.is(
					lines.length,
					layout === 'two_line' ? 2 : 1,
					`Rendered row: ${row}`,
				);
				for (const line of lines) {
					t.true(stringWidth(line) <= renderWidth, `Rendered row: ${row}`);
				}
			}
		}
	}
});
