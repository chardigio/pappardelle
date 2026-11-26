import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {snapshotOf} from '../test/helpers/program-status.ts';
import {
	connectRaw,
	hookState,
	manualTimers,
	serveTestDaemon,
	subscribeRaw,
	testPane,
	testSocketPath,
	type RawConnection,
} from '../test/helpers/status-daemon.ts';
import {until} from '../test/helpers/wait.ts';
import {withFileLock} from './file-lock.ts';
import {
	IDLE_EXIT_MS,
	MAX_SUBSCRIBER_BACKLOG_BYTES,
	serveStatusDaemon,
} from './status-daemon.ts';
import {encodeMessage, type DaemonMessage} from './status-protocol.ts';

const isHook = (workspaceName: string) => (message: DaemonMessage) =>
	message.type === 'hook' && message.state.workspaceName === workspaceName;

/** The daemon held nothing when `rail` subscribed, and has sent no more. */
function sentOnlyAnEmptyState(rail: RawConnection) {
	expect(rail.messages.length).toBe(1);
	expect(rail.messages[0]).toMatchObject({
		type: 'state',
		hooks: [],
		snapshots: [],
	});
}

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

test('a line from a socket that closes without reading reaches a subscriber as a push', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	const rail = await subscribeRaw(socketPath, 'repo');

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
	expect(rail.messages.at(-1)).toStrictEqual({
		type: 'hook',
		state: hookState('repo-A'),
	});
});

test('a connection that has not subscribed is written nothing', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	const rail = await subscribeRaw(socketPath, 'repo');
	const sender = await connectRaw(socketPath);
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
	const other = await connectRaw(socketPath);
	other.send({type: 'hook', state: hookState('repo-B')});
	await rail.received(isHook('repo-B'), 'another sender’s hook record');

	expect(bytes).toBe(0);
});

test('a second daemon started while the first is about to listen waits, then leaves the socket to the first', async () => {
	const socketPath = testSocketPath();
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
	expect(secondResult).toBe(undefined);

	letListen();
	const started = await first;
	teardown(async () => {
		if (started.kind === 'serving') await started.daemon.close();
	});
	expect(started.kind).toBe('serving');
	const later = await second;
	expect(later.kind).toBe('already-served');
	const rail = await subscribeRaw(socketPath, 'repo');
	sentOnlyAnEmptyState(rail);
});

test('a socket file that a killed daemon left is replaced', async () => {
	const socketPath = testSocketPath();
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
	expect(fs.existsSync(socketPath)).toBe(true);
	expect(await refused(socketPath)).toBe(true);

	await serveTestDaemon(socketPath);

	const rail = await subscribeRaw(socketPath, 'repo');
	sentOnlyAnEmptyState(rail);
});

test('the socket is the user’s alone', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);

	// eslint-disable-next-line no-bitwise -- Permission bits.
	expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
});

test('the daemon stops once the idle wait after its last connection closed is over, and removes its socket', async () => {
	const socketPath = testSocketPath();
	const clock = manualTimers();
	const daemon = await serveTestDaemon(socketPath, {timers: clock.timers});
	const first = await connectRaw(socketPath);
	const second = await connectRaw(socketPath);
	await until(() => clock.delays().length === 0, {
		what: 'the daemon to be in use',
	});

	first.socket.destroy();
	const rail = await subscribeRaw(socketPath, 'repo');
	expect(clock.delays()).toStrictEqual([]);

	second.socket.destroy();
	rail.socket.destroy();
	await until(() => clock.delays().length === 1, {
		what: 'the daemon to see that nothing is connected',
	});
	expect(clock.delays()).toStrictEqual([IDLE_EXIT_MS]);

	clock.fire();
	await daemon.closed;
	expect(fs.existsSync(socketPath)).toBe(false);
	expect(await refused(socketPath)).toBe(true);
});

test('a daemon that nothing connects to stops once the idle wait from its start is over', async () => {
	const socketPath = testSocketPath();
	const clock = manualTimers();
	const daemon = await serveTestDaemon(socketPath, {timers: clock.timers});
	expect(clock.delays()).toStrictEqual([IDLE_EXIT_MS]);

	clock.fire();
	await daemon.closed;
	expect(fs.existsSync(socketPath)).toBe(false);
});

test('a daemon about to stop stays for a connection that arrives before it has the lock', async () => {
	const socketPath = testSocketPath();
	const clock = manualTimers();
	await serveTestDaemon(socketPath, {timers: clock.timers});
	let release!: () => void;
	const starting = new Promise<void>(resolve => {
		release = resolve;
	});

	// What a daemon that is starting holds while it asks whether this one
	// answers.
	const candidate = withFileLock(socketPath, async () => starting);
	clock.fire();
	const rail = await subscribeRaw(socketPath, 'repo');
	release();
	await candidate;
	await withFileLock(socketPath, () => {});

	const sender = await connectRaw(socketPath);
	sender.send({type: 'hook', state: hookState('repo-A')});
	await rail.received(isHook('repo-A'), 'a push from the daemon that stayed');
	expect(fs.existsSync(socketPath)).toBe(true);
});

test('a daemon about to stop starts the idle wait again after a connection that came and went before it had the lock', async () => {
	const socketPath = testSocketPath();
	const clock = manualTimers();
	await serveTestDaemon(socketPath, {timers: clock.timers});
	let release!: () => void;
	const starting = new Promise<void>(resolve => {
		release = resolve;
	});

	// A daemon that is starting connects to ask whether this one answers, and
	// exits when it does. This one must then not stop under it.
	const candidate = withFileLock(socketPath, async () => starting);
	clock.fire();
	expect(await refused(socketPath)).toBe(false);
	await until(() => clock.delays().length === 1, {
		what: 'the daemon to see that connection close',
	});
	release();
	await candidate;
	await withFileLock(socketPath, () => {});

	expect(clock.delays()).toStrictEqual([IDLE_EXIT_MS]);
	const rail = await subscribeRaw(socketPath, 'repo');
	sentOnlyAnEmptyState(rail);
});

test('an invalid line is ignored, and the lines after it on that connection still apply', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	const rail = await subscribeRaw(socketPath, 'repo');
	const sender = await subscribeRaw(socketPath, 'other');

	sender.socket.write('not a message\n{"type":"hook","state":{}}\n');
	sender.send({type: 'subscribe', repo: 'other'});
	await until(() => sender.messages.length === 2, {
		what: 'the daemon to answer a line that came after the invalid ones',
	});
	sender.send({type: 'hook', state: hookState('repo-A')});

	await rail.received(isHook('repo-A'), 'the valid line');
	expect(rail.messages.slice(1)).toStrictEqual([
		{type: 'hook', state: hookState('repo-A')},
	]);
});

test('a subscriber that stops reading is disconnected at the backlog cap, and the others are not', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	const stopped = await subscribeRaw(socketPath, 'repo');
	const reading = await subscribeRaw(socketPath, 'repo');
	let stoppedClosed = false;
	stopped.socket.on('close', () => {
		stoppedClosed = true;
	});
	stopped.socket.pause();

	const monitor = await connectRaw(socketPath);
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
	await until(() => snapshots(reading.messages) === sent, {
		what: 'the reading subscriber to get every snapshot',
		timeoutMs: 20_000,
	});
	stopped.socket.resume();
	await until(() => stoppedClosed, {
		what: 'the stopped subscriber to be closed',
	});
	expect(snapshots(stopped.messages) < sent).toBe(true);

	monitor.send({type: 'hook', state: hookState('repo-A')});
	await reading.received(isHook('repo-A'), 'a push after the disconnect');
});
