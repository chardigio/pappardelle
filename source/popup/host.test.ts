import {EventEmitter, once} from 'node:events';
import {existsSync} from 'node:fs';
import {connect, type Socket} from 'node:net';
import path from 'node:path';
import test from 'ava';
import {openPopup, type PopupLaunch} from './host.ts';
import {
	createMessageDecoder,
	encodeMessage,
	type ChildMessage,
	type HostMessage,
	type PopupSpec,
} from './protocol.ts';

// Stands in for the ChildProcess that spawn() returns, which is an EventEmitter.
// eslint-disable-next-line unicorn/prefer-event-target
const fakeProcess = () => new EventEmitter();

const CONFIRM: PopupSpec = {
	kind: 'confirm',
	props: {title: 'Close Space', message: 'Close space bd-1?'},
};

type FakeChild = {
	popup: EventEmitter;
	launch: PopupLaunch;
	socket: Socket;
	received: HostMessage[];
	send(message: ChildMessage): void;
	next(type: HostMessage['type']): Promise<HostMessage>;
};

/**
 * Stand in for `tmux display-popup`: instead of running popup-cli.js, connect
 * to the host's socket from the test and play the child's side by hand.
 */
function fakeTmux() {
	let resolveChild: (child: FakeChild) => void;
	const child = new Promise<FakeChild>(resolve => {
		resolveChild = resolve;
	});
	const launch = (popupLaunch: PopupLaunch) => {
		const popup = fakeProcess();
		const socket = connect(popupLaunch.socketPath);
		const received: HostMessage[] = [];
		const events = fakeProcess();
		socket.on(
			'data',
			createMessageDecoder<HostMessage>(message => {
				received.push(message);
				events.emit(message.type, message);
			}),
		);
		// A real popup closes when popup-cli exits, which it does on `done`.
		socket.on('close', () => popup.emit('exit', 0));
		resolveChild({
			popup,
			launch: popupLaunch,
			socket,
			received,
			send(message) {
				socket.write(encodeMessage(message));
			},
			async next(type) {
				const seen = received.find(message => message.type === type);
				if (seen) return seen;
				const [message] = (await once(events, type)) as [HostMessage];
				return message;
			},
		});
		return popup;
	};

	return {launch, child};
}

const deps = (launch: (popupLaunch: PopupLaunch) => EventEmitter) => ({
	launch,
	env: {TMUX: '/tmp/tmux-test,1,0', LINCTL_API_KEY: 'secret'},
	cwd: '/repo',
	clientSize: async () => ({cols: 100, rows: 40}),
});

test('without tmux the popup is unavailable and nothing launches', async t => {
	let launched = false;
	const outcome = await openPopup(
		CONFIRM,
		{},
		{
			env: {},
			launch() {
				launched = true;
				return fakeProcess();
			},
		},
	);

	t.is(outcome, 'unavailable');
	t.false(launched);
});

test('the child gets the dialog, the TUI env and cwd, and a size', async t => {
	const tmux = fakeTmux();
	const result = openPopup(CONFIRM, {}, deps(tmux.launch));
	const child = await tmux.child;

	const init = await child.next('init');
	t.like(init, {
		type: 'init',
		kind: 'confirm',
		cwd: '/repo',
		env: {LINCTL_API_KEY: 'secret'},
	});
	t.is(child.launch.size.width, 72);

	child.send({type: 'cancel'});
	t.is(await result, 'cancelled');
});

test('done is sent only after the confirm handler finishes', async t => {
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
		deps(tmux.launch),
	);
	const child = await tmux.child;
	await child.next('init');

	child.send({type: 'confirm'});
	await new Promise(resolve => {
		setTimeout(resolve, 50);
	});
	t.true(handlerRan);
	t.false(child.received.some(message => message.type === 'done'));

	finishDelete();
	await child.next('done');
	t.is(await result, 'confirmed');
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
		deps(tmux.launch),
	);
	const child = await tmux.child;
	await child.next('init');

	child.socket.destroy();
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
		deps(tmux.launch),
	);
	void result.then(() => {
		resolved = true;
	});
	const child = await tmux.child;
	await child.next('init');

	child.send({type: 'confirm'});
	await new Promise(resolve => {
		setTimeout(resolve, 20);
	});
	child.socket.destroy();
	child.popup.emit('exit', 0);
	await new Promise(resolve => {
		setTimeout(resolve, 20);
	});
	t.false(resolved);

	finishDelete();
	t.is(await result, 'confirmed');
});

test('closeBeforeConfirm runs the action only after the popup has exited', async t => {
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
		deps(tmux.launch),
	);
	const child = await tmux.child;
	child.popup.on('exit', () => order.push('exit'));
	await child.next('init');

	child.send({type: 'confirm'});
	await child.next('done');
	child.socket.end();
	t.is(await result, 'confirmed');
	t.deepEqual(order, ['exit', 'confirm']);
});

test('the errors popup gets live updates and can clear', async t => {
	const tmux = fakeTmux();
	let push!: (errors: never[]) => void;
	let cleared = false;
	let unsubscribed = false;
	const result = openPopup(
		{kind: 'errors', props: {errors: []}},
		{
			subscribeErrors(listener) {
				push = listener;
				return () => {
					unsubscribed = true;
				};
			},
			onClearErrors() {
				cleared = true;
			},
		},
		deps(tmux.launch),
	);
	const child = await tmux.child;
	await child.next('init');

	push([]);
	await child.next('errors');
	child.send({type: 'clear-errors'});
	await result;
	t.true(cleared);
	t.true(unsubscribed);
});

test('a popup that fails to start is unavailable and leaves no socket dir', async t => {
	let socketPath = '';
	const outcome = await openPopup(
		CONFIRM,
		{},
		deps(popupLaunch => {
			socketPath = popupLaunch.socketPath;
			const popup = fakeProcess();
			setImmediate(() => popup.emit('error', new Error('spawn tmux ENOENT')));
			return popup;
		}),
	);

	t.is(outcome, 'unavailable');
	t.false(existsSync(path.dirname(socketPath)));
});
