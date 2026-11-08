import test from 'ava';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import ConfirmDialog from '../components/ConfirmDialog.tsx';
import type {ConfirmPopupProps} from './spec.ts';
import {popupSize} from './size.ts';

const noop = () => {};

// tmux can't resize an open popup, so its height must be exactly the rows
// OpenTUI lays the dialog out in: fewer clips the hint, more leaves blank rows.
const cases: Array<{cols: number; props: ConfirmPopupProps}> = [
	{
		cols: 30,
		props: {
			title: 'Close Space',
			message: '/home/user/.worktrees/project/very-long-branch-name-here',
			isDestructive: true,
		},
	},
	{
		cols: 50,
		props: {
			title: 'Close Space',
			message: 'Close space sta-1234-fix-the-very-long-hyphenated-thing?',
			detail: 'The worktree and git branch will remain on disk.',
			isDestructive: true,
		},
	},
	{
		cols: 50,
		props: {
			title: 'Remove Worktree',
			message:
				'Remove worktree /home/u/.worktrees/pappardelle/sta-1234-fix-thing?',
			isDestructive: true,
		},
	},
];

for (const {cols, props} of cases) {
	test.serial(
		`a ${cols}-column confirm popup is as tall as OpenTUI draws "${props.message}"`,
		async t => {
			const size = popupSize({kind: 'confirm', props}, {cols, rows: 80});
			const view = await render(
				React.createElement(ConfirmDialog, {
					...props,
					onConfirm: noop,
					onCancel: noop,
				}),
				{width: size.width, height: 80},
			);
			t.teardown(async () => {
				await view.unmount();
			});

			t.is(size.height, view.lastFrame().split('\n').length);
		},
	);
}
