import test from 'ava';
import React from 'react';
import {TextAttributes} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import SpaceListItem from './SpaceListItem.tsx';
import type {SpaceData} from '../types.ts';
import type {ListLayout} from '../config.ts';

const WIDTH = 40;

const space = (blocked: boolean): SpaceData => ({
	name: 'PAP-1',
	worktreePath: null,
	profileEmoji: '🍝',
	programStatus: blocked
		? {status: 'blocked', kind: 'permission'}
		: {status: 'idle'},
	linearIssue: {
		identifier: 'PAP-1',
		title: 'Short',
		state: {name: 'Open', type: 'unstarted', color: '#00ff00'},
	},
	railStatus: {
		pipeline: 'passing',
		unresolvedCommentCount: 2,
		hasConflict: false,
	},
});

async function rowSpans(blocked: boolean, layout: ListLayout) {
	const view = await render(
		React.createElement(
			'box',
			{flexDirection: 'column', width: WIDTH},
			React.createElement(SpaceListItem, {
				space: space(blocked),
				isSelected: true,
				width: WIDTH,
				layout,
			}),
		),
		{width: WIDTH, height: 2},
	);
	const lines = view
		.captureSpans()
		.lines.slice(0, layout === 'two_line' ? 2 : 1);
	await view.unmount();
	return lines.map(line => line.spans);
}

test('a selected row is one inverse bar from edge to edge, icons included', async t => {
	for (const layout of ['single_line', 'two_line'] as const) {
		for (const spans of await rowSpans(false, layout)) {
			const covered = spans
				// eslint-disable-next-line no-bitwise
				.filter(span => (span.attributes & TextAttributes.INVERSE) !== 0)
				.reduce((sum, span) => sum + span.width, 0);
			t.is(covered, WIDTH, `layout ${layout}`);
		}
	}
});

test('a blinking row fills the whole width with its block color', async t => {
	for (const layout of ['single_line', 'two_line'] as const) {
		for (const spans of await rowSpans(true, layout)) {
			const block = spans[0]!.fg;
			t.is(block.intent, 'indexed');
			const covered = spans
				.filter(span => span.fg.equals(block))
				.reduce((sum, span) => sum + span.width, 0);
			t.is(covered, WIDTH, `layout ${layout}`);
		}
	}
});
