import {execFile} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test, {type ExecutionContext} from 'ava';
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
import {encodeMessage, type ClientMessage} from './status-protocol.ts';

const execute = promisify(execFile);
const clientModule = fileURLToPath(
	new URL('status-client.ts', import.meta.url),
);

const snapshot = (key: string, generation: string) =>
	snapshotOf({repo: 'repo', key, pane: testPane(generation)}, [], {
		updatedAt: 1000,
	});

function testClient(
	t: ExecutionContext,
	socketPath: string,
	options: StatusClientOptions = {},
) {
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
	t.teardown(() => {
		client.close();
	});
	const changes: StatusChange[] = [];
	return {client, clock, started, changes};
}

/** Put `messages` in the daemon, and return once it holds them. */
async function seed(
	t: ExecutionContext,
	socketPath: string,
	messages: ClientMessage[],
) {
	const sender = await connectRaw(t, socketPath);
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

test('after ready() the replica holds what the daemon held, and each push after it', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	const sender = await seed(t, socketPath, [
		{type: 'hook', state: hookState('repo-A')},
		{type: 'snapshot', snapshot: snapshot('A', 'g1')},
		{type: 'snapshot', snapshot: snapshot('A', 'g2')},
	]);
	const {client, changes} = testClient(t, socketPath, {repo: 'repo'});

	await client.ready();
	t.deepEqual(client.hook('repo-A'), hookState('repo-A'));
	t.deepEqual(client.snapshot('A', 'g1'), snapshot('A', 'g1'));
	t.is(client.hook('repo-B'), undefined);

	client.onChange(change => changes.push(change));
	sender.send({type: 'hook', state: hookState('repo-B', 'waiting_for_input')});
	sender.send({type: 'snapshot', snapshot: snapshot('B', 'g1')});
	sender.send({type: 'forget', repo: 'repo', key: 'A', keep: 'g2'});
	await waitUntil(() => changes.length === 3, 'the three pushes');

	t.deepEqual(changes, [
		{kind: 'hook', statusKey: 'repo-B'},
		{kind: 'snapshot', key: 'B'},
		{kind: 'snapshot', key: 'A'},
	]);
	t.is(client.hook('repo-B')?.status, 'waiting_for_input');
	t.deepEqual(client.snapshot('B', 'g1'), snapshot('B', 'g1'));
	t.is(client.snapshot('A', 'g1'), undefined);
	t.deepEqual(client.snapshot('A', 'g2'), snapshot('A', 'g2'));
});

test('ready() gives up on a daemon that accepts and sends no state, stays connected, and a state that comes later is a change', async t => {
	const socketPath = testSocketPath(t);
	const accepted: net.Socket[] = [];
	const silent = net.createServer(connection => accepted.push(connection));
	silent.listen(socketPath);
	t.teardown(() => {
		for (const connection of accepted) connection.destroy();
		silent.close();
	});
	const {client, clock, changes} = testClient(t, socketPath, {repo: 'repo'});
	client.onChange(change => changes.push(change));
	let ready = false;
	const waiting = client.ready().then(() => {
		ready = true;
	});
	await waitUntil(
		() => accepted.length === 1 && clock.delays().length === 1,
		'the client to wait for the state',
	);
	t.false(ready);
	t.deepEqual(clock.delays(), [STATE_WAIT_MS]);

	clock.fire();
	await waiting;
	t.is(client.hook('repo-A'), undefined);
	t.deepEqual(clock.delays(), []);

	accepted[0]!.write(
		encodeMessage({
			type: 'state',
			hooks: [hookState('repo-A')],
			snapshots: [],
		}),
	);
	await waitUntil(() => changes.length === 1, 'the late state');
	t.deepEqual(changes, [{kind: 'hook', statusKey: 'repo-A'}]);
	t.deepEqual(client.hook('repo-A'), hookState('repo-A'));
});

test('after the daemon is replaced the client reconnects, resubscribes and tells listeners every key that either state held', async t => {
	const socketPath = testSocketPath(t);
	const first = await serveTestDaemon(t, socketPath);
	await seed(t, socketPath, [
		{type: 'hook', state: hookState('repo-A')},
		{type: 'snapshot', snapshot: snapshot('A', 'g1')},
	]);
	const {client, clock, changes} = testClient(t, socketPath, {repo: 'repo'});
	await client.ready();
	client.onChange(change => changes.push(change));

	await first.close();
	await waitUntil(
		() => clock.delays().length === 1,
		'the client to see that the daemon went away',
	);
	t.deepEqual(clock.delays(), [200]);
	t.deepEqual(client.hook('repo-A'), hookState('repo-A'));

	await serveTestDaemon(t, socketPath);
	const sender = await seed(t, socketPath, [
		{type: 'hook', state: hookState('repo-B')},
	]);
	clock.fire();
	await waitUntil(
		() => client.hook('repo-B') !== undefined,
		'the new daemon’s state',
	);

	t.is(client.hook('repo-A'), undefined);
	t.is(client.snapshot('A', 'g1'), undefined);
	t.deepEqual(changes, [
		{kind: 'hook', statusKey: 'repo-A'},
		{kind: 'hook', statusKey: 'repo-B'},
		{kind: 'snapshot', key: 'A'},
	]);

	sender.send({type: 'hook', state: hookState('repo-C')});
	await waitUntil(
		() => client.hook('repo-C') !== undefined,
		'a push from the new daemon',
	);
});

test('with nothing listening and start off, ready() resolves with an empty replica, no daemon is started, and a daemon started later is seen', async t => {
	const socketPath = testSocketPath(t);
	const {client, clock, started, changes} = testClient(t, socketPath, {
		repo: 'repo',
	});

	await client.ready();
	t.is(client.hook('repo-A'), undefined);
	t.is(
		await client.send({type: 'hook', state: hookState('repo-A')}),
		'unreachable',
	);

	client.onChange(change => changes.push(change));
	await serveTestDaemon(t, socketPath);
	await seed(t, socketPath, [{type: 'hook', state: hookState('repo-A')}]);
	clock.fire();
	await waitUntil(
		() => client.hook('repo-A') !== undefined,
		'the state of the daemon that started later',
	);

	t.deepEqual(changes, [{kind: 'hook', statusKey: 'repo-A'}]);
	t.deepEqual(started, []);
});

test('with start on, the first refused attempt starts a daemon and later ones do at each doubling of their count, and the wait between attempts doubles up to a cap', async t => {
	const socketPath = testSocketPath(t);
	const {client, clock, started} = testClient(t, socketPath, {start: true});

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

	t.deepEqual(startedAfter, [1, 2, 2, 3, 3, 3, 3, 4]);

	t.deepEqual(waits, [300, 400, 600, 1000, 1800, 3400, 5200, 5200]);
	t.deepEqual(new Set(started), new Set([socketPath]));
});

test('a client allowed to start a daemon after it was made does so from its next refused attempt', async t => {
	const socketPath = testSocketPath(t);
	const {client, clock, started} = testClient(t, socketPath);

	await client.ready();
	t.deepEqual(started, []);
	client.allowStart();
	clock.fire();
	await waitUntil(() => clock.delays().length === 1, 'the second attempt');

	t.deepEqual(started, [socketPath]);
});

test('a connect listener runs on every connection, so a publisher’s latest status reaches a daemon that replaced the first', async t => {
	const socketPath = testSocketPath(t);
	const first = await serveTestDaemon(t, socketPath);
	const {client: publisher, clock} = testClient(t, socketPath);
	const latest = {type: 'snapshot', snapshot: snapshot('A', 'g1')} as const;
	publisher.onConnect(() => {
		void publisher.send(latest);
	});
	t.is(await publisher.send(latest), 'sent');

	await first.close();
	await waitUntil(
		() => clock.delays().length === 1,
		'the publisher to see that the daemon went away',
	);
	await serveTestDaemon(t, socketPath);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	clock.fire();

	await rail.received(
		message => message.type === 'snapshot',
		'the snapshot sent again',
	);
	t.deepEqual(rail.messages, [
		{type: 'state', hooks: [], snapshots: []},
		latest,
	]);
});

test('a client with no repo is pushed nothing', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	const {client: publisher, changes} = testClient(t, socketPath);
	const {client: rail} = testClient(t, socketPath, {repo: 'repo'});
	publisher.onChange(change => changes.push(change));
	await Promise.all([publisher.ready(), rail.ready()]);

	await publisher.send({type: 'hook', state: hookState('repo-A')});
	await waitUntil(() => rail.hook('repo-A') !== undefined, 'the push');

	t.deepEqual(changes, []);
	t.is(publisher.hook('repo-A'), undefined);
});

test('a closed client makes no further attempt', async t => {
	const socketPath = testSocketPath(t);
	const {client, clock} = testClient(t, socketPath, {repo: 'repo'});
	await client.ready();
	t.is(clock.delays().length, 1);

	client.close();

	t.deepEqual(clock.delays(), []);
	t.is(
		await client.send({type: 'hook', state: hookState('repo-A')}),
		'unreachable',
	);
});

test('two clients with start on, started together, end up on one daemon', async t => {
	const socketPath = testSocketPath(t);
	const pids: number[] = [];
	t.teardown(() => {
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
		testClient(t, socketPath, {repo: 'repo', start: true, startDaemon}),
	) as [ReturnType<typeof testClient>, ReturnType<typeof testClient>];
	await Promise.all([one.client.ready(), two.client.ready()]);
	t.is(pids.length, 2);
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
	t.is(
		await one.client.send({type: 'hook', state: hookState('repo-A')}),
		'sent',
	);
	await waitUntil(
		() => two.client.hook('repo-A') !== undefined,
		'the other client to be pushed what the first sent',
	);
	t.is(pids.filter(pid => isPidAlive(pid)).length, 1);
});

test('a process with a connected client and no other work exits', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	await seed(t, socketPath, [{type: 'hook', state: hookState('repo-A')}]);

	const printed = await inAnotherProcess(
		socketPath,
		`
			const client = new StatusClient(socketPath, {repo: 'repo'});
			await client.ready();
			console.log(client.hook('repo-A')?.status);
		`,
	);

	t.is(printed, 'processing');
});

test('a process whose last work is a send has its line written, and exits', async t => {
	const socketPath = testSocketPath(t);
	await serveTestDaemon(t, socketPath);
	const rail = await subscribeRaw(t, socketPath, 'repo');

	const printed = await inAnotherProcess(
		socketPath,
		`
			const client = new StatusClient(socketPath, {repo: 'repo'});
			await client.ready();
			console.log(await client.send({type: 'forget', repo: 'repo', key: 'A'}));
		`,
	);

	t.is(printed, 'sent');
	await rail.received(message => message.type === 'forgotten', 'the forget');
});
