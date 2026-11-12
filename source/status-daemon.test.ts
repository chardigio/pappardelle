import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {snapshotOf} from '../test/helpers/program-status.ts';
import {
	connectRaw,
	hookState,
	manualTimers,
	serveTestDaemon,
	subscribeRaw,
	testPane,
	testSocketPath,
} from '../test/helpers/status-daemon.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {withFileLock} from './file-lock.ts';
import {
	IDLE_EXIT_MS,
	MAX_SUBSCRIBER_BACKLOG_BYTES,
	serveStatusDaemon,
} from './status-daemon.ts';
import {encodeMessage, type DaemonMessage} from './status-protocol.ts';

const isHook = (workspaceName: string) => (message: DaemonMessage) =>
	message.type === 'hook' && message.state.workspaceName === workspaceName;

async function refused(socketPath: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect(socketPath);
		socket.once('connect', () => {
			socket.destroy();
			resolve(false);
		});
		socket.once('error', () => {
			resolve(true);
		});
	});
}

test('a line from a socket that closes without reading reaches a subscriber as a push', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	const rail = await subscribeRaw(t, socketPath, 'repo');

	const hook = net.connect(socketPath);
	hook.on('connect', () => {
		hook.write(
			encodeMessage({type: 'hook', state: hookState('repo-A')}),
			() => {
				hook.destroy();
			},
		);
	});

	await rail.received(isHook('repo-A'), 'the hook record');
	t.deepEqual(rail.messages.at(-1), {
		type: 'hook',
		state: hookState('repo-A'),
	});
});

test('a connection that has not subscribed is written nothing', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	const sender = await connectRaw(t, socketPath);
	let bytes = 0;
	sender.socket.on('data', (text: string) => {
		bytes += text.length;
	});

	sender.send({type: 'hook', state: hookState('repo-A')});
	sender.send({
		type: 'snapshot',
		snapshot: snapshotOf({repo: 'repo', key: 'A', pane: testPane('g1')}, []),
	});
	sender.send({type: 'forget', repo: 'repo', key: 'A'});
	await rail.received(
		message => message.type === 'forgotten',
		'the last of the sender’s lines',
	);
	const other = await connectRaw(t, socketPath);
	other.send({type: 'hook', state: hookState('repo-B')});
	await rail.received(isHook('repo-B'), 'another sender’s hook record');

	t.is(bytes, 0);
});

test('a second daemon started while the first is about to listen waits, then leaves the socket to the first', async t => {
	const socketPath = testSocketPath(t);
	let reachedListen!: () => void;
	const aboutToListen = new Promise<void>(resolve => {
		reachedListen = resolve;
	});
	let letListen!: () => void;
	const held = new Promise<void>(resolve => {
		letListen = resolve;
	});

	const first = serveStatusDaemon(socketPath, {
		timers: manualTimers().timers,
		async beforeListen() {
			reachedListen();
			await held;
		},
	});
	await aboutToListen;
	let secondResult: string | undefined;
	const second = serveStatusDaemon(socketPath, {
		timers: manualTimers().timers,
	}).then(start => {
		secondResult = start.kind;
		return start;
	});
	await delay(50);
	t.is(secondResult, undefined);

	letListen();
	const started = await first;
	t.teardown(async () => {
		if (started.kind === 'serving') await started.daemon.close();
	});
	t.is(started.kind, 'serving');
	const later = await second;
	t.is(later.kind, 'already-served');
	const rail = await subscribeRaw(t, socketPath, 'repo');
	t.deepEqual(rail.messages, [{type: 'state', hooks: [], snapshots: []}]);
});

test('a socket file that a killed daemon left is replaced', async t => {
	const socketPath = testSocketPath(t);
	const killed = spawn(
		process.execPath,
		[
			'-e',
			`require('node:net').createServer().listen(process.argv[1], () => console.log('listening'))`,
			socketPath,
		],
		{stdio: ['ignore', 'pipe', 'inherit']},
	);
	await new Promise(resolve => {
		killed.stdout.once('data', resolve);
	});
	killed.kill('SIGKILL');
	await new Promise(resolve => {
		killed.once('exit', resolve);
	});
	t.true(fs.existsSync(socketPath));
	t.true(await refused(socketPath));

	await serveTestDaemon(t, socketPath);

	const rail = await subscribeRaw(t, socketPath, 'repo');
	t.deepEqual(rail.messages, [{type: 'state', hooks: [], snapshots: []}]);
});

test('the socket is the user’s alone', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);

	// eslint-disable-next-line no-bitwise -- Permission bits.
	t.is(fs.statSync(socketPath).mode & 0o777, 0o600);
});

test('the daemon stops ten seconds after its last connection closes, and removes its socket', async t => {
	const socketPath = testSocketPath(t);
	const clock = manualTimers();
	const daemon = await serveTestDaemon(t, socketPath, {timers: clock.timers});
	const first = await connectRaw(t, socketPath);
	const second = await connectRaw(t, socketPath);
	await waitUntil(() => clock.delays().length === 0, 'the daemon to be in use');

	first.socket.destroy();
	const rail = await subscribeRaw(t, socketPath, 'repo');
	t.deepEqual(clock.delays(), []);

	second.socket.destroy();
	rail.socket.destroy();
	await waitUntil(
		() => clock.delays().length === 1,
		'the daemon to see that nothing is connected',
	);
	t.deepEqual(clock.delays(), [IDLE_EXIT_MS]);

	clock.fire();
	await daemon.closed;
	t.false(fs.existsSync(socketPath));
	t.true(await refused(socketPath));
});

test('a daemon that nothing connects to stops ten seconds after it started', async t => {
	const socketPath = testSocketPath(t);
	const clock = manualTimers();
	const daemon = await serveTestDaemon(t, socketPath, {timers: clock.timers});
	t.deepEqual(clock.delays(), [IDLE_EXIT_MS]);

	clock.fire();
	await daemon.closed;
	t.false(fs.existsSync(socketPath));
});

test('a daemon about to stop stays for a connection that arrives before it has the lock', async t => {
	const socketPath = testSocketPath(t);
	const clock = manualTimers();
	await serveTestDaemon(t, socketPath, {timers: clock.timers});
	let release!: () => void;
	const starting = new Promise<void>(resolve => {
		release = resolve;
	});

	// What a daemon that is starting holds while it asks whether this one
	// answers.
	const candidate = withFileLock(socketPath, async () => starting);
	clock.fire();
	const rail = await subscribeRaw(t, socketPath, 'repo');
	release();
	await candidate;
	await withFileLock(socketPath, () => {});

	const sender = await connectRaw(t, socketPath);
	sender.send({type: 'hook', state: hookState('repo-A')});
	await rail.received(isHook('repo-A'), 'a push from the daemon that stayed');
	t.true(fs.existsSync(socketPath));
});

test('a daemon about to stop stays ten more seconds after a connection that came and went before it had the lock', async t => {
	const socketPath = testSocketPath(t);
	const clock = manualTimers();
	await serveTestDaemon(t, socketPath, {timers: clock.timers});
	let release!: () => void;
	const starting = new Promise<void>(resolve => {
		release = resolve;
	});

	// A daemon that is starting connects to ask whether this one answers, and
	// exits when it does. This one must then not stop under it.
	const candidate = withFileLock(socketPath, async () => starting);
	clock.fire();
	t.false(await refused(socketPath));
	await waitUntil(
		() => clock.delays().length === 1,
		'the daemon to see that connection close',
	);
	release();
	await candidate;
	await withFileLock(socketPath, () => {});

	t.deepEqual(clock.delays(), [IDLE_EXIT_MS]);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	t.deepEqual(rail.messages, [{type: 'state', hooks: [], snapshots: []}]);
});

test('an invalid line is ignored, and the lines after it on that connection still apply', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	const sender = await subscribeRaw(t, socketPath, 'other');

	sender.socket.write('not a message\n{"type":"hook","state":{}}\n');
	sender.send({type: 'subscribe', repo: 'other'});
	await waitUntil(
		() => sender.messages.length === 2,
		'the daemon to answer a line that came after the invalid ones',
	);
	sender.send({type: 'hook', state: hookState('repo-A')});

	await rail.received(isHook('repo-A'), 'the valid line');
	t.deepEqual(rail.messages.slice(1), [
		{type: 'hook', state: hookState('repo-A')},
	]);
});

test('a subscriber that stops reading is disconnected at the backlog cap, and the others are not', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	const stopped = await subscribeRaw(t, socketPath, 'repo');
	const reading = await subscribeRaw(t, socketPath, 'repo');
	let stoppedClosed = false;
	stopped.socket.on('close', () => {
		stoppedClosed = true;
	});
	stopped.socket.pause();

	const monitor = await connectRaw(t, socketPath);
	const padding = 'x'.repeat(256 * 1024);
	const sent = Math.ceil((2 * MAX_SUBSCRIBER_BACKLOG_BYTES) / padding.length);
	for (let index = 0; index < sent; index++) {
		monitor.send({
			type: 'snapshot',
			snapshot: snapshotOf(
				{repo: 'repo', key: 'A', pane: {...testPane('g1'), marker: padding}},
				[],
				{updatedAt: index},
			),
		});
	}

	const snapshots = (messages: DaemonMessage[]) =>
		messages.filter(message => message.type === 'snapshot').length;
	await waitUntil(
		() => snapshots(reading.messages) === sent,
		'the reading subscriber to get every snapshot',
		20_000,
	);
	stopped.socket.resume();
	await waitUntil(() => stoppedClosed, 'the stopped subscriber to be closed');
	t.true(snapshots(stopped.messages) < sent);

	monitor.send({type: 'hook', state: hookState('repo-A')});
	await reading.received(isHook('repo-A'), 'a push after the disconnect');
});
