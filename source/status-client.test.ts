import {execFile} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, promisify} from 'node:util';
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
} from '../test/helpers/status-daemon.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {isPidAlive} from './file-lock.ts';
import {
	STATE_WAIT_MS,
	StatusClient,
	spawnStatusDaemon,
	type StatusChange,
	type StatusClientOptions,
} from './status-client.ts';
import {
	LineReader,
	encodeMessage,
	parseClientMessage,
	type ClientMessage,
	type DaemonMessage,
} from './status-protocol.ts';

const execute = promisify(execFile);
const clientModule = fileURLToPath(
	new URL('status-client.ts', import.meta.url),
);

const snapshot = (key: string, generation: string) =>
	snapshotOf({repo: 'repo', key, pane: testPane(generation)}, [], {
		updatedAt: 1000,
	});

function testClient(socketPath: string, options: StatusClientOptions = {}) {
	const clock = manualTimers();
	const started: string[] = [];
	const client = new StatusClient(socketPath, {
		timers: clock.timers,
		random: () => 0.5,
		startDaemon(daemonSocket) {
			started.push(daemonSocket);
		},
		...options,
	});
	teardown(() => {
		client.close();
	});
	const changes: StatusChange[] = [];
	return {client, clock, started, changes};
}

/** Put `messages` in the daemon, and return once it holds them. */
async function seed(socketPath: string, messages: ClientMessage[]) {
	const sender = await connectRaw(socketPath);
	for (const message of messages) sender.send(message);
	sender.send({type: 'subscribe', repo: 'repo'});
	await sender.received(
		message => message.type === 'state',
		'the daemon to hold the seeded status',
	);
	return sender;
}

/**
 * Run `body` in a process of its own, where it is the only work, and return
 * what it printed.
 */
async function inAnotherProcess(
	socketPath: string,
	body: string,
): Promise<string> {
	// Bun keeps a process alive for a pending top-level await whatever its
	// sockets say, so the body runs in a function nothing waits for.
	const script = `
		import {StatusClient} from ${JSON.stringify(clientModule)};
		const socketPath = process.argv[1];
		void (async () => {
			${body}
		})();
	`;
	const {stdout} = await execute(process.execPath, ['-e', script, socketPath], {
		timeout: 20_000,
		env: {...process.env, HOME: path.dirname(socketPath)},
	});
	return stdout.trim();
}

test('after ready() the replica holds what the daemon held, and each push after it', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	const sender = await seed(socketPath, [
		{type: 'hook', state: hookState('repo-A')},
		{type: 'snapshot', snapshot: snapshot('A', 'g1')},
		{type: 'snapshot', snapshot: snapshot('A', 'g2')},
	]);
	const {client, changes} = testClient(socketPath, {repo: 'repo'});

	await client.ready();
	expect(client.hook('repo-A')).toStrictEqual(hookState('repo-A'));
	expect(client.snapshot('A', 'g1')).toStrictEqual(snapshot('A', 'g1'));
	expect(client.hook('repo-B')).toBe(undefined);

	client.onChange(change => changes.push(change));
	sender.send({type: 'hook', state: hookState('repo-B', 'waiting_for_input')});
	sender.send({type: 'snapshot', snapshot: snapshot('B', 'g1')});
	sender.send({type: 'forget', repo: 'repo', key: 'A', keep: 'g2'});
	await waitUntil(() => changes.length === 3, 'the three pushes');

	expect(changes).toStrictEqual([
		{kind: 'hook', statusKey: 'repo-B'},
		{kind: 'snapshot', key: 'B'},
		{kind: 'snapshot', key: 'A'},
	]);
	expect(client.hook('repo-B')?.status).toBe('waiting_for_input');
	expect(client.snapshot('B', 'g1')).toStrictEqual(snapshot('B', 'g1'));
	expect(client.snapshot('A', 'g1')).toBe(undefined);
	expect(client.snapshot('A', 'g2')).toStrictEqual(snapshot('A', 'g2'));
});

test('ready() gives up on a daemon that accepts and sends no state, stays connected, and a state that comes later is a change', async () => {
	const socketPath = testSocketPath();
	const accepted: net.Socket[] = [];
	const silent = net.createServer(connection => accepted.push(connection));
	silent.listen(socketPath);
	teardown(() => {
		for (const connection of accepted) connection.destroy();
		silent.close();
	});
	const {client, clock, changes} = testClient(socketPath, {repo: 'repo'});
	client.onChange(change => changes.push(change));
	let ready = false;
	const waiting = client.ready().then(() => {
		ready = true;
	});
	await waitUntil(
		() => accepted.length === 1 && clock.delays().length === 1,
		'the client to wait for the state',
	);
	expect(ready).toBe(false);
	expect(clock.delays()).toStrictEqual([STATE_WAIT_MS]);

	clock.fire();
	await waiting;
	expect(client.hook('repo-A')).toBe(undefined);
	expect(clock.delays()).toStrictEqual([]);

	accepted[0]!.write(
		encodeMessage({
			type: 'state',
			daemon: 'daemon',
			hooks: [hookState('repo-A')],
			snapshots: [],
		}),
	);
	await waitUntil(() => changes.length === 1, 'the late state');
	expect(changes).toStrictEqual([{kind: 'hook', statusKey: 'repo-A'}]);
	expect(client.hook('repo-A')).toStrictEqual(hookState('repo-A'));
});

test('after the daemon is replaced the client reconnects, keeps what it knew, sends the new daemon the hook records it lacks, and tells listeners every key', async () => {
	const socketPath = testSocketPath();
	const first = await serveTestDaemon(socketPath);
	await seed(socketPath, [
		{type: 'hook', state: hookState('repo-A', 'waiting_for_approval')},
		{type: 'hook', state: hookState('repo-B')},
		{type: 'snapshot', snapshot: snapshot('A', 'g1')},
	]);
	const {client, clock, changes} = testClient(socketPath, {repo: 'repo'});
	await client.ready();
	client.onChange(change => changes.push(change));

	await first.close();
	await waitUntil(
		() => clock.delays().length === 1,
		'the client to see that the daemon went away',
	);
	expect(clock.delays()).toStrictEqual([200]);

	// The new daemon has heard from repo-B's agent since, and from nobody else.
	await serveTestDaemon(socketPath);
	const newer = {...hookState('repo-B', 'waiting_for_input'), lastUpdate: 2000};
	const sender = await seed(socketPath, [{type: 'hook', state: newer}]);
	clock.fire();

	await sender.received(
		message =>
			message.type === 'hook' && message.state.workspaceName === 'repo-A',
		'the hook record the new daemon lacked',
	);
	expect(client.hook('repo-A')).toStrictEqual(
		hookState('repo-A', 'waiting_for_approval'),
	);
	expect(client.hook('repo-B')).toStrictEqual(newer);
	expect(client.snapshot('A', 'g1')).toStrictEqual(snapshot('A', 'g1'));
	for (const change of [
		{kind: 'hook', statusKey: 'repo-A'},
		{kind: 'hook', statusKey: 'repo-B'},
		{kind: 'snapshot', key: 'A'},
	] as const) {
		expect(
			changes.some(told => isDeepStrictEqual(told, change)),
			`listeners were told of ${JSON.stringify(change)}`,
		).toBe(true);
	}

	const reader = await subscribeRaw(socketPath, 'repo');
	expect(
		reader.messages.find(message => message.type === 'state'),
	).toMatchObject({
		hooks: [newer, hookState('repo-A', 'waiting_for_approval')],
	});

	sender.send({type: 'hook', state: hookState('repo-C')});
	await waitUntil(
		() => client.hook('repo-C') !== undefined,
		'a push from the new daemon',
	);
});

test('a state from the daemon the client was on replaces the replica: what the daemon forgot while the connection was down is dropped, and nothing is sent back to it', async () => {
	const socketPath = testSocketPath();
	const states: DaemonMessage[] = [
		{
			type: 'state',
			daemon: 'daemon',
			hooks: [hookState('repo-A')],
			snapshots: [snapshot('A', 'g1'), snapshot('B', 'g1')],
		},
		{
			type: 'state',
			daemon: 'daemon',
			hooks: [],
			snapshots: [snapshot('B', 'g1')],
		},
	];
	const accepted: net.Socket[] = [];
	const received: ClientMessage[] = [];
	const daemon = net.createServer(connection => {
		const state = states[accepted.length]!;
		accepted.push(connection);
		const reader = new LineReader();
		connection.setEncoding('utf8');
		connection.on('data', (text: string) => {
			for (const line of reader.feed(text)) {
				const parsed = parseClientMessage(line);
				if (parsed.kind !== 'message') continue;
				received.push(parsed.message);
				if (parsed.message.type === 'subscribe')
					connection.write(encodeMessage(state));
			}
		});
	});
	daemon.listen(socketPath);
	teardown(() => {
		for (const connection of accepted) connection.destroy();
		daemon.close();
	});
	const {client, clock, changes} = testClient(socketPath, {repo: 'repo'});
	await client.ready();
	client.onChange(change => changes.push(change));

	accepted[0]!.destroy();
	await waitUntil(
		() => clock.delays().length === 1,
		'the client to see that the connection closed',
	);
	clock.fire();
	await waitUntil(() => changes.length > 0, 'the state after the reconnect');

	expect(client.snapshot('A', 'g1')).toBe(undefined);
	expect(client.snapshot('B', 'g1')).toStrictEqual(snapshot('B', 'g1'));
	expect(client.hook('repo-A')).toBe(undefined);
	expect(changes).toStrictEqual([
		{kind: 'hook', statusKey: 'repo-A'},
		{kind: 'snapshot', key: 'A'},
		{kind: 'snapshot', key: 'B'},
	]);

	// A line sent now is behind anything the client sent on applying the state.
	const last = {type: 'forget', repo: 'repo', key: 'C'} as const;
	await client.send(last);
	await waitUntil(() => received.at(-1)?.type === 'forget', 'the last line');
	const subscribe = {type: 'subscribe', repo: 'repo'};
	expect(received).toStrictEqual([subscribe, subscribe, last]);
});

test('with nothing listening and start off, ready() resolves with an empty replica, no daemon is started, and a daemon started later is seen', async () => {
	const socketPath = testSocketPath();
	const {client, clock, started, changes} = testClient(socketPath, {
		repo: 'repo',
	});

	await client.ready();
	expect(client.hook('repo-A')).toBe(undefined);
	expect(await client.send({type: 'hook', state: hookState('repo-A')})).toBe(
		'unreachable',
	);

	client.onChange(change => changes.push(change));
	await serveTestDaemon(socketPath);
	await seed(socketPath, [{type: 'hook', state: hookState('repo-A')}]);
	clock.fire();
	await waitUntil(
		() => client.hook('repo-A') !== undefined,
		'the state of the daemon that started later',
	);

	expect(changes).toStrictEqual([{kind: 'hook', statusKey: 'repo-A'}]);
	expect(started).toStrictEqual([]);
});

test('with start on, the first refused attempt starts a daemon and later ones do at each doubling of their count, and the wait between attempts doubles up to a cap', async () => {
	const socketPath = testSocketPath();
	const {client, clock, started} = testClient(socketPath, {start: true});

	await client.ready();
	const waits: number[] = [];
	const startedAfter: number[] = [];
	for (let attempt = 1; attempt <= 8; attempt++) {
		await waitUntil(
			() => clock.delays().length === 1,
			`attempt ${attempt} to be refused`,
		);
		startedAfter.push(started.length);
		waits.push(...clock.delays());
		clock.fire();
	}

	expect(startedAfter).toStrictEqual([1, 2, 2, 3, 3, 3, 3, 4]);

	expect(waits).toStrictEqual([300, 400, 600, 1000, 1800, 3400, 5200, 5200]);
	expect(new Set(started)).toStrictEqual(new Set([socketPath]));
});

test('a client allowed to start a daemon after it was made does so from its next refused attempt', async () => {
	const socketPath = testSocketPath();
	const {client, clock, started} = testClient(socketPath);

	await client.ready();
	expect(started).toStrictEqual([]);
	client.allowStart();
	clock.fire();
	await waitUntil(() => clock.delays().length === 1, 'the second attempt');

	expect(started).toStrictEqual([socketPath]);
});

test('a connect listener runs on every connection, so a publisher’s latest status reaches a daemon that replaced the first', async () => {
	const socketPath = testSocketPath();
	const first = await serveTestDaemon(socketPath);
	const {client: publisher, clock} = testClient(socketPath);
	const latest = {type: 'snapshot', snapshot: snapshot('A', 'g1')} as const;
	publisher.onConnect(() => {
		void publisher.send(latest);
	});
	expect(await publisher.send(latest)).toBe('sent');

	await first.close();
	await waitUntil(
		() => clock.delays().length === 1,
		'the publisher to see that the daemon went away',
	);
	await serveTestDaemon(socketPath);
	const rail = await subscribeRaw(socketPath, 'repo');
	clock.fire();

	await rail.received(
		message => message.type === 'snapshot',
		'the snapshot sent again',
	);
	expect(rail.messages[0]).toMatchObject({
		type: 'state',
		hooks: [],
		snapshots: [],
	});
	expect(rail.messages.slice(1)).toStrictEqual([latest]);
});

test('a client with no repo is pushed nothing', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	const {client: publisher, changes} = testClient(socketPath);
	const {client: rail} = testClient(socketPath, {repo: 'repo'});
	publisher.onChange(change => changes.push(change));
	await Promise.all([publisher.ready(), rail.ready()]);

	await publisher.send({type: 'hook', state: hookState('repo-A')});
	await waitUntil(() => rail.hook('repo-A') !== undefined, 'the push');

	expect(changes).toStrictEqual([]);
	expect(publisher.hook('repo-A')).toBe(undefined);
});

test('a closed client makes no further attempt', async () => {
	const socketPath = testSocketPath();
	const {client, clock} = testClient(socketPath, {repo: 'repo'});
	await client.ready();
	expect(clock.delays().length).toBe(1);

	client.close();

	expect(clock.delays()).toStrictEqual([]);
	expect(await client.send({type: 'hook', state: hookState('repo-A')})).toBe(
		'unreachable',
	);
});

test('two clients with start on, started together, end up on one daemon', async () => {
	const socketPath = testSocketPath();
	const pids: number[] = [];
	teardown(() => {
		for (const pid of pids.filter(pid => isPidAlive(pid)))
			process.kill(pid, 'SIGKILL');
	});
	const startDaemon = (daemonSocket: string) => {
		pids.push(
			spawnStatusDaemon(daemonSocket, {
				...process.env,
				HOME: path.dirname(socketPath),
			})!,
		);
	};

	const [one, two] = [1, 2].map(() =>
		testClient(socketPath, {repo: 'repo', start: true, startDaemon}),
	) as [ReturnType<typeof testClient>, ReturnType<typeof testClient>];
	await Promise.all([one.client.ready(), two.client.ready()]);
	expect(pids.length).toBe(2);
	await waitUntil(
		() => pids.filter(pid => isPidAlive(pid)).length === 1,
		'one of the two daemons to give way to the other',
		30_000,
	);

	const connected: StatusClient[] = [];
	for (const {client} of [one, two]) {
		client.onConnect(() => connected.push(client));
	}

	one.clock.fire();
	two.clock.fire();
	await waitUntil(() => connected.length === 2, 'both clients to connect');
	expect(
		await one.client.send({type: 'hook', state: hookState('repo-A')}),
	).toBe('sent');
	await waitUntil(
		() => two.client.hook('repo-A') !== undefined,
		'the other client to be pushed what the first sent',
	);
	expect(pids.filter(pid => isPidAlive(pid)).length).toBe(1);
});

test('a process with a connected client and no other work exits', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	await seed(socketPath, [{type: 'hook', state: hookState('repo-A')}]);

	const printed = await inAnotherProcess(
		socketPath,
		`
			const client = new StatusClient(socketPath, {repo: 'repo'});
			await client.ready();
			console.log(client.hook('repo-A')?.status);
		`,
	);

	expect(printed).toBe('processing');
});

test('a process whose last work is a send has its line written, and exits', async () => {
	const socketPath = testSocketPath();
	await serveTestDaemon(socketPath);
	const rail = await subscribeRaw(socketPath, 'repo');

	const printed = await inAnotherProcess(
		socketPath,
		`
			const client = new StatusClient(socketPath, {repo: 'repo'});
			await client.ready();
			console.log(await client.send({type: 'forget', repo: 'repo', key: 'A'}));
		`,
	);

	expect(printed).toBe('sent');
	await rail.received(message => message.type === 'forgotten', 'the forget');
});
