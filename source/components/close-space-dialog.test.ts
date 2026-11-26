import {test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import {until} from '../../test/helpers/wait.ts';
import type {StateChoice} from '../close-state-choice.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerState,
} from '../providers/types.ts';
import CloseSpaceDialog from './CloseSpaceDialog.tsx';

const RIGHT = '\u001B[C';
// Named apart from the "Closed" placeholder shown while loading, so a frame
// with "Done" is one drawn after the load.
const STATES: TrackerState[] = [
	{id: 'open', name: 'Open', done: false},
	{id: 'closed', name: 'Done', done: true},
	{id: 'deferred', name: 'Deferred', done: false},
];
const ISSUE: TrackerIssue = {
	identifier: 'bd-1',
	title: 't',
	state: {name: 'In Progress', type: 'started', color: ''},
	project: null,
};

function trackerWithStates() {
	let resolve!: (states: TrackerState[]) => void;
	const loaded = new Promise<TrackerState[]>(_resolve => {
		resolve = _resolve;
	});
	const tracker = {
		listStates: async () => loaded,
		setIssueState: async () => true,
		closeIssue: async () => true,
	} as unknown as IssueTrackerProvider;
	return {tracker, load: () => resolve(STATES)};
}

async function setup(tracker: IssueTrackerProvider | null, issue = ISSUE) {
	const confirmed: Array<StateChoice | undefined> = [];
	let calls = 0;
	const view = await render(
		React.createElement(CloseSpaceDialog, {
			spaceName: 'bd-1',
			currentIssue: issue,
			tracker,
			onConfirm(choice) {
				calls++;
				confirmed.push(choice);
			},
			onCancel() {},
		}),
	);
	return {view, confirmed, calls: () => calls};
}

test('defaults to the closed-id state and Right moves to the next state', async () => {
	const {tracker, load} = trackerWithStates();
	const dialog = await setup(tracker);
	teardown(async () => {
		await dialog.view.unmount();
	});
	load();
	await until(() => dialog.view.lastFrame().includes('Issue state: ‹ Done ›'), {
		frame: dialog.view.lastFrame,
	});

	await dialog.view.stdin.write(RIGHT);
	await until(() => dialog.view.lastFrame().includes('‹ Deferred ›'), {
		frame: dialog.view.lastFrame,
	});

	await dialog.view.stdin.write('\r');
	await until(() => dialog.calls() > 0);
	expect(dialog.confirmed[0]).toMatchObject({
		kind: 'set',
		state: {id: 'deferred'},
	});
});

test('Enter before the states load still closes the issue', async () => {
	const {tracker} = trackerWithStates();
	const dialog = await setup(tracker);
	teardown(async () => {
		await dialog.view.unmount();
	});

	await dialog.view.stdin.write('\r');
	await until(() => dialog.calls() > 0);
	expect(dialog.confirmed[0]).toStrictEqual({kind: 'close'});
});

test('a choice made while loading survives the load', async () => {
	const {tracker, load} = trackerWithStates();
	// A canceled issue defaults to leaving it as is, so picking Closed is a
	// choice the load could lose.
	const dialog = await setup(tracker, {
		...ISSUE,
		state: {name: 'Canceled', type: 'canceled', color: ''},
	});
	teardown(async () => {
		await dialog.view.unmount();
	});
	await until(() => dialog.view.lastFrame().includes('‹ Leave as Canceled ›'), {
		frame: dialog.view.lastFrame,
	});

	await dialog.view.stdin.write(RIGHT);
	await until(() => dialog.view.lastFrame().includes('‹ Closed ›'), {
		frame: dialog.view.lastFrame,
	});

	load();
	await until(() => dialog.view.lastFrame().includes('‹ Done ›'), {
		frame: dialog.view.lastFrame,
	});
	expect().pass();
});

test('a tracker that cannot set states gets the plain dialog', async () => {
	const dialog = await setup({} as IssueTrackerProvider);
	teardown(async () => {
		await dialog.view.unmount();
	});
	await until(
		() => dialog.view.lastFrame().includes('Press y or Enter to confirm'),
		{frame: dialog.view.lastFrame},
	);
	expect(dialog.view.lastFrame()).not.toMatch(/Issue state/);

	await dialog.view.stdin.write('y');
	await until(() => dialog.calls() > 0);
	expect(dialog.confirmed).toStrictEqual([undefined]);
});
