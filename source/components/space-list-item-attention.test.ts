import test from 'ava';
import React from 'react';
import {TextAttributes} from '@opentui/core';
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
			// Cells are encoded as stored: SGR 7 plus this fg and bg. The terminal
			// swaps them into a palette-colored block with text in its own
			// background color, as Ink's inverse did.
			const slot = kind === 'question' ? 4 : 1;
			for (const span of row) {
				const label = `${kind}, selected=${isSelected}: "${span.text}"`;
				t.false(span.fg.equals(span.bg), label);
				// eslint-disable-next-line no-bitwise
				t.true((span.attributes & TextAttributes.INVERSE) !== 0, label);
				t.is(span.fg.intent, 'indexed', label);
				t.is(span.fg.slot, slot, label);
				t.is(span.bg.intent, 'default', label);
			}
		}
	}
});
