import test from 'ava';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import SpaceListItem from './SpaceListItem.tsx';

for (const layout of ['single_line', 'two_line'] as const) {
	test.serial(
		`native mouse hit testing follows ${layout} rows below a banner`,
		async t => {
			let selected = '';
			const view = await render(
				React.createElement(
					'box',
					{flexDirection: 'column', width: 40},
					React.createElement('text', {height: 3}, 'wrapped banner'),
					React.createElement(SpaceListItem, {
						space: {
							name: 'TASK-1',
							worktreePath: null,
							programStatus: {status: 'idle'},
						},
						isSelected: false,
						width: 40,
						layout,
						onSelect(name) {
							selected = name;
						},
					}),
				),
				{width: 40, height: 10},
			);
			t.teardown(() => view.unmount());
			await view.mockMouse.click(5, layout === 'two_line' ? 4 : 3);
			t.is(selected, 'TASK-1');
			selected = '';
			await view.mockMouse.click(5, 0);
			t.is(selected, '');
		},
	);
}

test('pending rows do not select a workspace', async t => {
	let selected = false;
	const view = await render(
		React.createElement(SpaceListItem, {
			space: {name: 'pending', worktreePath: null, isPending: true},
			isSelected: false,
			width: 40,
			layout: 'single_line',
			onSelect() {
				selected = true;
			},
		}),
		{width: 40, height: 5},
	);
	t.teardown(() => view.unmount());
	await view.mockMouse.click(5, 0);
	t.false(selected);
});
