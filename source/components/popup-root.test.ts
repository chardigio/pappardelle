import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
import {viewIssue} from '../popup/issue-viewer.ts';
import type {ChildMessage, HostMessage, PopupSpec} from '../popup/protocol.ts';
import PopupRoot, {type PopupChannel} from './PopupRoot.tsx';

function setup(spec: PopupSpec) {
	const sent: ChildMessage[] = [];
	const listeners = new Set<(message: HostMessage) => void>();
	let exits = 0;
	const channel: PopupChannel = {
		send(message) {
			sent.push(message);
		},
		onMessage(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const view = render(
		React.createElement(PopupRoot, {
			spec,
			channel,
			width: 80,
			height: 20,
			onExit() {
				exits++;
			},
		}),
	);
	return {
		view,
		sent,
		exits: () => exits,
		fromHost(message: HostMessage) {
			for (const listener of listeners) listener(message);
		},
	};
}

async function until(check: () => boolean, frame?: () => string | undefined) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline)
			throw new Error(`condition never held\n${String(frame?.())}`);
		await delay(10);
	}
}

const CLOSE_SPACE: PopupSpec = {
	kind: 'confirm',
	props: {
		title: 'Close Space',
		message: 'Close space bd-1?',
		processingMessage: 'Closing space bd-1…',
	},
};

test.serial(
	'confirming shows the spinner and waits for the TUI to finish',
	async t => {
		const popup = setup(CLOSE_SPACE);
		t.teardown(() => popup.view.unmount());
		await delay(20);

		popup.view.stdin.write('y');
		await until(
			() => popup.view.lastFrame()?.includes('Closing space bd-1…') ?? false,
		);
		await until(() => popup.sent.length > 0);
		t.deepEqual(popup.sent, [{type: 'confirm'}]);
		t.is(popup.exits(), 0);

		popup.fromHost({type: 'done'});
		t.is(popup.exits(), 1);
	},
);

test.serial('Esc cancels and exits without confirming', async t => {
	const popup = setup(CLOSE_SPACE);
	t.teardown(() => popup.view.unmount());
	await delay(20);

	popup.view.stdin.write('\u001B');
	await until(() => popup.exits() === 1);
	t.deepEqual(popup.sent, [{type: 'cancel'}]);
});

test.serial(
	'the errors popup follows live updates and asks the TUI to clear',
	async t => {
		const popup = setup({kind: 'errors', props: {errors: []}});
		t.teardown(() => popup.view.unmount());
		await delay(20);
		t.true(popup.view.lastFrame()?.includes('No errors.'));

		popup.fromHost({
			type: 'errors',
			errors: [
				{
					timestamp: '2026-09-27T00:00:00Z',
					level: 'error',
					component: 'tracker',
					message: 'fetch failed',
				},
			],
		});
		await until(
			() => popup.view.lastFrame()?.includes('fetch failed') ?? false,
		);

		popup.view.stdin.write('c');
		await until(() => popup.sent.length > 0);
		t.deepEqual(popup.sent, [{type: 'clear-errors'}]);
	},
);

test.serial(
	'an issue opened from the prompt shows in place and Esc returns to the typed prompt',
	async t => {
		const popup = setup({kind: 'prompt', props: {}});
		t.teardown(() => popup.view.unmount());
		await delay(50);

		popup.view.stdin.write('fix the rail');
		await until(
			() => popup.view.lastFrame()?.includes('fix the rail') ?? false,
		);

		t.true(await viewIssue(['printf', 'issue body line'], 'bd-9'));
		await until(
			() => popup.view.lastFrame()?.includes('issue body line') ?? false,
			() => popup.view.lastFrame(),
		);
		t.false(popup.view.lastFrame()?.includes('New Session'));

		popup.view.stdin.write('q');
		await until(
			() => popup.view.lastFrame()?.includes('New Session') ?? false,
			() => popup.view.lastFrame(),
		);
		t.true(popup.view.lastFrame()?.includes('fix the rail'));
		t.deepEqual(popup.sent, []);
		t.is(popup.exits(), 0);
	},
);
