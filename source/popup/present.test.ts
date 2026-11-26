import {PassThrough} from 'node:stream';
import {test, expect} from 'bun:test';
import {until} from '../../test/helpers/wait.ts';
import {presentPopup} from './present.tsx';
import type {PopupActions, PopupSpec} from './spec.ts';
import type {PopupTerminal} from './terminal.ts';

const HELP: PopupSpec = {
	kind: 'help',
	props: {customKeybindings: [], commitSha: 'abc1234'},
};

function fakeTerminal() {
	let isListening = false;
	let isTtyDead = false;
	const input = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode(mode: boolean) {
			// What Bun throws once tmux has closed the popup's tty.
			if (isTtyDead) throw new TypeError('fd must be a number');
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
	let dismissals = 0;
	const terminal = {
		input,
		output,
		closed,
		dismiss() {
			dismissals++;
		},
		close() {
			closes++;
		},
	} as unknown as PopupTerminal;
	return {
		terminal,
		closes: () => closes,
		dismissals: () => dismissals,
		closeFromTmux,
		killTty() {
			isTtyDead = true;
		},
		/** The renderer takes raw mode once the dialog is listening for keys. */
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

test('Ctrl+C in the popup cancels and closes its terminal', async () => {
	const fake = fakeTerminal();
	const {actions, cancels} = fakeActions();
	presentPopup(HELP, actions, fake.terminal);
	await until(fake.isListening);

	fake.terminal.input.write('\u0003');
	await until(() => cancels() === 1);
	expect(fake.closes()).toBe(1);
});

test('tmux closing the popup unmounts the dialog as a cancel', async () => {
	const fake = fakeTerminal();
	const {actions, cancels} = fakeActions();
	presentPopup(HELP, actions, fake.terminal);
	await until(fake.isListening);

	fake.closeFromTmux();
	await until(() => cancels() === 1);
	expect().pass();
});

test('closing waits for the current key handler before unmounting', async () => {
	const fake = fakeTerminal();
	const {actions} = fakeActions();
	const close = presentPopup(HELP, actions, fake.terminal);
	await until(fake.isListening);

	close();
	// The popup leaves the client without waiting for the renderer.
	expect(fake.dismissals()).toBe(1);
	expect(fake.closes()).toBe(0);
	await until(() => fake.closes() === 1);
	expect().pass();
});

test('tmux closing the popup does not log the dead tty as an error', async () => {
	const fake = fakeTerminal();
	const {actions, cancels} = fakeActions();
	presentPopup(HELP, actions, fake.terminal);
	await until(fake.isListening);

	fake.killTty();

	const logged: unknown[][] = [];
	const consoleError = console.error;
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
	try {
		fake.closeFromTmux();
		await until(() => cancels() === 1);
	} finally {
		console.error = consoleError;
	}

	expect(logged).toStrictEqual([]);
});
