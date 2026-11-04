import test from 'ava';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import SpaceListItem from './SpaceListItem.tsx';
import type {SpaceData} from '../types.ts';

const space = (kind: 'permission' | 'question'): SpaceData => ({
	name: 'PAP-1',
	worktreePath: null,
	programStatus: {status: 'blocked', kind},
	linearIssue: {
		identifier: 'PAP-1',
		title: 'Blocked on the user',
		state: {name: 'Open', type: 'unstarted', color: '#00ff00'},
	},
	railStatus: {
		pipeline: 'passing',
		unresolvedCommentCount: 2,
		hasConflict: true,
	},
});

test('a blocked row keeps its text distinguishable from the blink block', async t => {
	for (const kind of ['permission', 'question'] as const) {
		for (const isSelected of [false, true]) {
			const view = await render(
				React.createElement(SpaceListItem, {
					space: space(kind),
					isSelected,
					width: 60,
					layout: 'single_line',
				}),
				{width: 60, height: 1},
			);
			const row = view.captureSpans().lines[0]!.spans;
			await view.unmount();
			const text = row.map(span => span.text).join('');
			t.true(text.includes('PAP-1'), `Rendered row: ${text}`);
			for (const span of row.filter(span => span.text.trim().length > 0)) {
				t.false(
					span.fg.equals(span.bg),
					`${kind}, selected=${isSelected}: "${span.text}" is drawn in its own background color`,
				);
			}
		}
	}
});
