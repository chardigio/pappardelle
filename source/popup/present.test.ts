import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {presentPopup} from './present.tsx';
import type {PopupActions, PopupSpec} from './spec.ts';
import type {PopupTerminal} from './terminal.ts';

const HELP: PopupSpec = {
	kind: 'help',
	props: {customKeybindings: [], commitSha: 'abc1234'},
};

function fakeTerminal() {
	let isListening = false;
	const input = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode(mode: boolean) {
			isListening = mode;
			return input;
		},
		ref() {
			return input;
		},
		unref() {
			return input;
		},
	});
	const output = Object.assign(new PassThrough(), {
		isTTY: true,
		columns: 60,
		rows: 30,
	});
	output.resume();
	let closeFromTmux!: () => void;
	const closed = new Promise<void>(resolve => {
		closeFromTmux = resolve;
	});
	let closes = 0;
	const terminal = {
		input,
		output,
		closed,
		close() {
			closes++;
		},
	} as unknown as PopupTerminal;
	return {
		terminal,
		closes: () => closes,
		closeFromTmux,
		/** Ink takes raw mode once the dialog is listening for keys. */
		isListening: () => isListening,
	};
}

function fakeActions() {
	let cancels = 0;
	const actions: PopupActions = {
		async confirm() {},
		cancel() {
			cancels++;
		},
		async clearErrors() {},
	};
	return {actions, cancels: () => cancels};
}

async function until(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('condition never held');
		await delay(10);
	}
}

test('Ctrl+C in the popup cancels and closes its terminal', async t => {
	const fake = fakeTerminal();
	const {actions, cancels} = fakeActions();
	presentPopup(HELP, actions, fake.terminal);
	await until(fake.isListening);

	fake.terminal.input.write('\u0003');
	await until(() => cancels() === 1);
	t.is(fake.closes(), 1);
});

test('tmux closing the popup unmounts the dialog as a cancel', async t => {
	const fake = fakeTerminal();
	const {actions, cancels} = fakeActions();
	presentPopup(HELP, actions, fake.terminal);
	await until(fake.isListening);

	fake.closeFromTmux();
	await until(() => cancels() === 1);
	t.pass();
});

test('closing waits for the current key handler before unmounting', async t => {
	const fake = fakeTerminal();
	const {actions} = fakeActions();
	const close = presentPopup(HELP, actions, fake.terminal);
	await until(fake.isListening);

	close();
	t.is(fake.closes(), 0);
	await until(() => fake.closes() === 1);
	t.pass();
});
