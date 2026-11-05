import test from 'ava';
import React from 'react';
import {RGBA} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import SpaceListItem from './SpaceListItem.tsx';
import type {SpaceData} from '../types.ts';

async function keySpan(space: SpaceData) {
	const view = await render(
		React.createElement(SpaceListItem, {
			space,
			isSelected: false,
			width: 60,
			layout: 'single_line',
		}),
		{width: 60, height: 1},
	);
	const {spans} = view.captureSpans().lines[0]!;
	await view.unmount();
	return spans.find(span => span.text.includes(space.name))!;
}

test('a pending row draws its key in the default foreground, not ANSI white', async t => {
	const key = await keySpan({
		name: 'PAP-9',
		worktreePath: null,
		isPending: true,
		pendingTitle: 'Opening…',
	});
	t.true(key.fg.equals(RGBA.defaultForeground()));
});

test('a key whose tracker state is gray stays off the Solarized background', async t => {
	const key = await keySpan({
		name: 'bd-1',
		worktreePath: null,
		linearIssue: {
			identifier: 'bd-1',
			title: 'Open issue',
			state: {name: 'open', type: 'open', color: 'gray'},
		},
	});
	t.true(key.fg.equals(RGBA.defaultForeground()));
});
