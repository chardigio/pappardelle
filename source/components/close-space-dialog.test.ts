import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
import type {StateChoice} from '../close-state-choice.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerState,
} from '../providers/types.ts';
import CloseSpaceDialog from './CloseSpaceDialog.tsx';

const RIGHT = '\u001B[C';
const STATES: TrackerState[] = [
	{id: 'open', name: 'Open', done: false},
	{id: 'closed', name: 'Closed', done: true},
	{id: 'deferred', name: 'Deferred', done: false},
];
const ISSUE: TrackerIssue = {
	identifier: 'bd-1',
	title: 't',
	state: {name: 'Open', type: 'open', color: ''},
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

function setup(tracker: IssueTrackerProvider | null) {
	const confirmed: Array<StateChoice | undefined> = [];
	let calls = 0;
	const view = render(
		React.createElement(CloseSpaceDialog, {
			spaceName: 'bd-1',
			currentIssue: ISSUE,
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

async function until(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('condition never held');
		await delay(10);
	}
}

test.serial('defaults to Closed and Right moves to the next state', async t => {
	const {tracker, load} = trackerWithStates();
	const dialog = setup(tracker);
	t.teardown(() => dialog.view.unmount());
	load();
	await delay(20);
	t.regex(dialog.view.lastFrame()!, /Issue state: ‹ Closed ›/);

	dialog.view.stdin.write(RIGHT);
	await delay(20);
	t.regex(dialog.view.lastFrame()!, /‹ Deferred ›/);

	dialog.view.stdin.write('\r');
	await until(() => dialog.calls() > 0);
	t.like(dialog.confirmed[0], {kind: 'set', state: {id: 'deferred'}});
});

test.serial('Enter before the states load still closes the issue', async t => {
	const {tracker} = trackerWithStates();
	const dialog = setup(tracker);
	t.teardown(() => dialog.view.unmount());
	await delay(20);

	dialog.view.stdin.write('\r');
	await until(() => dialog.calls() > 0);
	t.deepEqual(dialog.confirmed[0], {kind: 'close'});
});

test.serial('a choice made while loading survives the load', async t => {
	const {tracker, load} = trackerWithStates();
	const dialog = setup(tracker);
	t.teardown(() => dialog.view.unmount());
	await delay(20);

	dialog.view.stdin.write(RIGHT);
	await delay(20);
	t.regex(dialog.view.lastFrame()!, /‹ Leave as Open ›/);

	load();
	await delay(20);
	t.regex(dialog.view.lastFrame()!, /‹ Leave as Open ›/);
});

test.serial(
	'a tracker that cannot set states gets the plain dialog',
	async t => {
		const dialog = setup({} as IssueTrackerProvider);
		t.teardown(() => dialog.view.unmount());
		await delay(20);
		t.notRegex(dialog.view.lastFrame()!, /Issue state/);
		t.regex(dialog.view.lastFrame()!, /Press y or Enter to confirm/);

		dialog.view.stdin.write('y');
		await until(() => dialog.calls() > 0);
		t.deepEqual(dialog.confirmed, [undefined]);
	},
);
