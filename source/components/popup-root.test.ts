import test from 'ava';
import React from 'react';
import {render, until} from '../../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import type {LogEntry} from '../logger.ts';
import type {ConfirmPayload, PopupActions, PopupSpec} from '../popup/spec.ts';
import PopupRoot from './PopupRoot.tsx';

async function setup(spec: PopupSpec) {
	const confirms: Array<ConfirmPayload | undefined> = [];
	let cancels = 0;
	let clears = 0;
	let finishConfirm!: () => void;
	let pushErrors: (errors: LogEntry[]) => void = () => {};
	const actions: PopupActions = {
		async confirm(payload) {
			confirms.push(payload);
			return new Promise<void>(resolve => {
				finishConfirm = resolve;
			});
		},
		cancel() {
			cancels++;
		},
		async clearErrors() {
			clears++;
		},
		subscribeErrors(push) {
			pushErrors = push;
			return () => {
				pushErrors = () => {};
			};
		},
	};
	const view = await render(
		React.createElement(PopupRoot, {spec, actions, width: 80, height: 20}),
	);
	return {
		view,
		confirms,
		cancels: () => cancels,
		clears: () => clears,
		finishConfirm() {
			finishConfirm();
		},
		pushErrors(errors: LogEntry[]) {
			pushErrors(errors);
		},
	};
}

const CLOSE_SPACE: PopupSpec = {
	kind: 'confirm',
	props: {
		title: 'Close Space',
		message: 'Close space bd-1?',
		processingMessage: 'Closing space bd-1…',
		isDestructive: true,
	},
};

test.serial(
	'confirming shows the spinner and waits for the TUI to finish',
	async t => {
		const popup = await setup(CLOSE_SPACE);
		t.teardown(async () => {
			await popup.view.unmount();
		});
		await until(
			() => popup.view.lastFrame().includes('Close space bd-1?'),
			popup.view.lastFrame,
		);

		const rows = popup.view.lastFrame().split('\n').length;
		await popup.view.stdin.write('y');
		await until(
			() => popup.view.lastFrame().includes('Closing space bd-1…'),
			popup.view.lastFrame,
		);
		const frame = popup.view.lastFrame() ?? '';
		t.is(frame.split('\n').length, rows);
		t.true(frame.includes('Close space bd-1?'));
		t.false(frame.includes('to cancel'));
		await until(() => popup.confirms.length > 0);
		t.deepEqual(popup.confirms, [undefined]);

		// The TUI closes the popup once the deletion finishes; until then the
		// spinner stays. Nothing is meant to change, so there's no frame to wait
		// for and a fixed window has to do.
		popup.finishConfirm();
		await delay(20);
		t.true(popup.view.lastFrame()?.includes('Closing space bd-1…'));
		t.is(popup.cancels(), 0);
	},
);

test.serial('Esc cancels without confirming', async t => {
	const popup = await setup(CLOSE_SPACE);
	t.teardown(async () => {
		await popup.view.unmount();
	});

	await popup.view.stdin.write('\u001B');
	await until(() => popup.cancels() === 1);
	t.deepEqual(popup.confirms, []);
});

test.serial(
	'the errors popup follows live updates and asks the TUI to clear',
	async t => {
		const popup = await setup({kind: 'errors', props: {errors: []}});
		t.teardown(async () => {
			await popup.view.unmount();
		});
		await until(
			() => popup.view.lastFrame().includes('No errors.'),
			popup.view.lastFrame,
		);

		popup.pushErrors([
			{
				timestamp: '2026-09-27T00:00:00Z',
				level: 'error',
				component: 'tracker',
				message: 'fetch failed',
			},
		]);
		await until(
			() => popup.view.lastFrame().includes('fetch failed'),
			popup.view.lastFrame,
		);

		await popup.view.stdin.write('c');
		await until(() => popup.clears() === 1);
		t.pass();
	},
);
