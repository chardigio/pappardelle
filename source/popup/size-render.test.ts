import {test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import {until} from '../../test/helpers/wait.ts';
import CloseSpaceDialog from '../components/CloseSpaceDialog.tsx';
import HelpOverlay from '../components/HelpOverlay.tsx';
import type {IssueTrackerProvider} from '../providers/types.ts';
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
	test(`a ${cols}-column confirm popup is as tall as OpenTUI draws "${props.message}"`, async () => {
		const size = popupSize({kind: 'confirm', props}, {cols, rows: 80});
		const view = await render(
			React.createElement(ConfirmDialog, {
				...props,
				onConfirm: noop,
				onCancel: noop,
			}),
			{width: size.width, height: 80},
		);
		teardown(async () => {
			await view.unmount();
		});

		expect(size.height).toBe(view.lastFrame().split('\n').length);
	});
}

const pickingTracker = {
	listStates: async () => [],
	setIssueState: async () => true,
	closeIssue: async () => true,
} as unknown as IssueTrackerProvider;

for (const cols of [30, 80]) {
	test(`a ${cols}-column Close Space popup fits its rows and shows the whole state choice`, async () => {
		const spec = {
			kind: 'close-space',
			props: {spaceName: 'bd-1', currentIssue: null},
		} as const;
		const size = popupSize(spec, {cols, rows: 80});
		const view = await render(
			React.createElement(CloseSpaceDialog, {
				...spec.props,
				tracker: pickingTracker,
				isFullHeight: true,
				onConfirm: noop,
				onCancel: noop,
			}),
			{width: size.width, height: size.height},
		);
		teardown(async () => {
			await view.unmount();
		});

		await until(
			() => view.lastFrame().includes('‹ Closed ›'),
			() => view.lastFrame(),
		);
		const rows = view.lastFrame().split('\n');
		expect(rows.length).toBe(size.height);
		expect(rows.at(-3)!.includes('cancel'), 'the hint is the last row').toBe(
			true,
		);
	});
}

test('the help popup is wide enough for a custom command OpenTUI measures wider than widest-line', async () => {
	const customKeybindings = [
		{key: 'z', name: `Deploy­${'x'.repeat(60)}­­­end`, run: 'true'},
	];
	const size = popupSize(
		{kind: 'help', props: {customKeybindings, commitSha: 'abc1234'}},
		{cols: 200, rows: 80},
	);
	const view = await render(
		React.createElement(HelpOverlay, {
			commitSha: 'abc1234',
			customKeybindings,
			onClose: noop,
		}),
		{width: size.width, height: 80},
	);
	teardown(async () => {
		await view.unmount();
	});

	await until(() => view.lastFrame().includes('Deploy'));
	const row = view
		.lastFrame()
		.split('\n')
		.find(line => line.includes('Deploy'))!;
	expect(row.includes('end'), 'the custom command row is not clipped').toBe(
		true,
	);
});
