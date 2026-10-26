import test from 'ava';
import {openPopup, type ShowPopup} from './host.ts';
import type {PopupActions, PopupSpec} from './spec.ts';
import type {PopupSize} from './size.ts';

const CONFIRM: PopupSpec = {
	kind: 'confirm',
	props: {title: 'Close Space', message: 'Close space bd-1?'},
};

type FakeDialog = {
	size: PopupSize;
	actions: PopupActions;
	/** How many times the host asked to close the popup. */
	closes: () => number;
	closed: Promise<void>;
	/** The popup going away, as tmux closing it would. */
	closeFromTmux: () => void;
};

/**
 * Stand in for the popup: instead of rendering PopupRoot into a tmux popup,
 * hold the actions and answer by hand.
 */
function fakeTmux() {
	let resolveDialog: (dialog: FakeDialog) => void;
	const dialog = new Promise<FakeDialog>(resolve => {
		resolveDialog = resolve;
	});
	const show: ShowPopup = async (_spec, size, actions) => {
		let closeFromTmux!: () => void;
		const closed = new Promise<void>(resolve => {
			closeFromTmux = resolve;
		});
		let closes = 0;
		resolveDialog({
			size,
			actions,
			closes: () => closes,
			closed,
			closeFromTmux,
		});
		return {
			closed,
			close() {
				closes++;
				closeFromTmux();
			},
		};
	};

	return {show, dialog};
}

const deps = (show: ShowPopup) => ({
	show,
	env: {TMUX: '/tmp/tmux-test,1,0'},
	clientSize: async () => ({cols: 100, rows: 40}),
});

const tick = async (ms = 20) =>
	new Promise(resolve => {
		setTimeout(resolve, ms);
	});

test('without tmux the popup is unavailable and nothing is shown', async t => {
	let shown = false;
	const outcome = await openPopup(
		CONFIRM,
		{},
		{
			env: {},
			async show() {
				shown = true;
				return undefined;
			},
		},
	);

	t.is(outcome, 'unavailable');
	t.false(shown);
});

test('a popup that cannot be shown is unavailable', async t => {
	const outcome = await openPopup(
		CONFIRM,
		{},
		deps(async () => undefined),
	);

	t.is(outcome, 'unavailable');
});

test('the dialog is sized for the client', async t => {
	const tmux = fakeTmux();
	const result = openPopup(CONFIRM, {}, deps(tmux.show));
	const dialog = await tmux.dialog;

	t.is(dialog.size.width, 72);

	dialog.actions.cancel();
	t.is(await result, 'cancelled');
	t.is(dialog.closes(), 1);
});

test('the popup closes only after the confirm handler finishes', async t => {
	const tmux = fakeTmux();
	let finishDelete!: () => void;
	const deleting = new Promise<void>(resolve => {
		finishDelete = resolve;
	});
	let handlerRan = false;
	const result = openPopup(
		CONFIRM,
		{
			async onConfirm() {
				handlerRan = true;
				await deleting;
			},
		},
		deps(tmux.show),
	);
	const dialog = await tmux.dialog;

	const confirmed = dialog.actions.confirm();
	await tick();
	t.true(handlerRan);
	t.is(dialog.closes(), 0);

	finishDelete();
	await confirmed;
	t.is(await result, 'confirmed');
	t.is(dialog.closes(), 1);
});

test('the popup closing before an answer is a cancel, and no handler runs', async t => {
	const tmux = fakeTmux();
	let handlerRan = false;
	const result = openPopup(
		CONFIRM,
		{
			onConfirm() {
				handlerRan = true;
			},
		},
		deps(tmux.show),
	);
	const dialog = await tmux.dialog;

	dialog.closeFromTmux();
	t.is(await result, 'cancelled');
	t.false(handlerRan);
});

test('the popup closing mid-action does not resolve until the action finishes', async t => {
	const tmux = fakeTmux();
	let finishDelete!: () => void;
	const deleting = new Promise<void>(resolve => {
		finishDelete = resolve;
	});
	let resolved = false;
	const result = openPopup(
		CONFIRM,
		{onConfirm: async () => deleting},
		deps(tmux.show),
	);
	void result.then(() => {
		resolved = true;
	});
	const dialog = await tmux.dialog;

	void dialog.actions.confirm();
	await tick();
	dialog.closeFromTmux();
	// The dialog unmounting reports a cancel, which must not end the action.
	dialog.actions.cancel();
	await tick();
	t.false(resolved);

	finishDelete();
	t.is(await result, 'confirmed');
});

test('closeBeforeConfirm runs the action only after the popup has closed', async t => {
	const tmux = fakeTmux();
	const order: string[] = [];
	const result = openPopup(
		CONFIRM,
		{
			closeBeforeConfirm: true,
			onConfirm() {
				order.push('confirm');
			},
		},
		deps(tmux.show),
	);
	const dialog = await tmux.dialog;
	void dialog.closed.then(() => order.push('closed'));

	void dialog.actions.confirm();
	t.is(await result, 'confirmed');
	t.deepEqual(order, ['closed', 'confirm']);
});

test('clearing errors runs the handler, then closes the popup', async t => {
	const tmux = fakeTmux();
	let cleared = false;
	const result = openPopup(
		{kind: 'errors', props: {errors: []}},
		{
			onClearErrors() {
				cleared = true;
			},
		},
		deps(tmux.show),
	);
	const dialog = await tmux.dialog;

	await dialog.actions.clearErrors();
	t.is(await result, 'confirmed');
	t.true(cleared);
	t.is(dialog.closes(), 1);
});

test('the payload the dialog confirms with reaches the handler', async t => {
	const tmux = fakeTmux();
	let received: unknown;
	const result = openPopup(
		CONFIRM,
		{
			onConfirm(payload) {
				received = payload;
			},
		},
		deps(tmux.show),
	);
	const dialog = await tmux.dialog;

	const choice = {
		kind: 'set',
		state: {id: 'deferred', name: 'Deferred', done: false},
	};
	await dialog.actions.confirm({choice} as never);
	t.is(await result, 'confirmed');
	t.deepEqual(received, {choice});
});
