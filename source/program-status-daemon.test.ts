import {execFile, execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test, {type ExecutionContext} from 'ava';
import {
	killProcessesNaming,
	processesNaming,
} from '../test/helpers/processes.ts';
import {
	publishSnapshot,
	publishSnapshotFile,
	readStatus,
	snapshotOf,
} from '../test/helpers/program-status.ts';
import {testState} from '../test/helpers/state.ts';
import {
	hookState,
	manualTimers,
	serveTestDaemon,
	subscribeRaw,
	testSocketPath,
	type RawConnection,
} from '../test/helpers/status-daemon.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {
	createProgramStatusDao,
	followedPublisher,
	LAST_SEND_WAIT_MS,
} from './program-status-daemon.ts';
import {
	parseStatusPane,
	programStatusPath,
	type ProgramStatusSnapshot,
} from './program-status-monitor.ts';
import type {ProgramReport} from './program-status.ts';
import {statusSocketPath} from './state-db.ts';
import {StatusClient, type SendResult} from './status-client.ts';

const execute = promisify(execFile);
const pane = parseStatusPane('%1\t12\t0\t1\t12.owner', 'test-status')!;
const target = {repo: 'repo', key: 'STA-1', pane};
const at = 1_800_000_000_000;
const report = (state: string): ProgramReport[] => [{state, id: ''}];

/** A monitor's publisher whose clock, flag and reconnects the test moves. */
function testPublisher(
	t: ExecutionContext,
	socketPath: string,
	options: {daemonMode: boolean},
) {
	const dir = path.join(path.dirname(socketPath), 'program-status', 'repo');
	mkdirSync(dir, {recursive: true});
	const file = programStatusPath(dir, target.key, pane.generation);
	const clock = manualTimers();
	const clients: StatusClient[] = [];
	let now = 5000;
	let {daemonMode} = options;
	let asked = 0;
	const publisher = followedPublisher({
		dir,
		socketPath,
		daemonMode() {
			asked++;
			return daemonMode;
		},
		now: () => now,
		timers: clock.timers,
		connect(daemonSocket) {
			const client = new StatusClient(daemonSocket, {
				start: true,
				timers: clock.timers,
				random: () => 0,
				startDaemon() {},
			});
			clients.push(client);
			return client;
		},
	});
	t.teardown(() => {
		for (const client of clients) client.close();
	});
	return {
		publisher,
		clock,
		clients,
		file,
		grantLease() {
			writeFileSync(`${file}.lease`, '');
		},
		revokeLease() {
			execFileSync('rm', [`${file}.lease`]);
		},
		setFlag(on: boolean) {
			daemonMode = on;
		},
		advance(ms: number) {
			now += ms;
		},
		asked: () => asked,
	};
}

const sentStatuses = (rail: RawConnection) =>
	rail.messages.flatMap(message =>
		message.type === 'snapshot' ? [message.snapshot.info.status] : [],
	);

/**
 * Returns once the daemon has taken everything `client` sent before this:
 * a line sent now is behind those on the same connection.
 */
async function sentSoFar(client: StatusClient, rail: RawConnection) {
	const marker = `marker-${rail.messages.length}-${Date.now()}`;
	await client.send({type: 'hook', state: hookState(marker)});
	await rail.received(
		message =>
			message.type === 'hook' && message.state.workspaceName === marker,
		'what the publisher sent so far',
	);
}

test('of a snapshot the daemon holds and a snapshot file, the newer is read', async t => {
	const state = testState(t, {sqlite: true});
	await publishSnapshot(
		state,
		snapshotOf(target, report('working'), {updatedAt: at}),
	);
	publishSnapshotFile(
		state,
		snapshotOf(target, report('done'), {updatedAt: at + 1000}),
	);
	t.is(await readStatus(state, 'STA-1', pane), 'done');

	await publishSnapshot(
		state,
		snapshotOf(target, report('blocked'), {updatedAt: at + 2000}),
	);
	t.is(await readStatus(state, 'STA-1', pane), 'blocked');
});

test('a snapshot from a monitor that writes only files is read with the flag on', async t => {
	const state = testState(t, {sqlite: true});
	publishSnapshotFile(
		state,
		snapshotOf(target, [{state: 'working', id: '', app: 'older-binary'}]),
	);

	t.like(await state.daos.programStatus.read('STA-1', pane), {
		info: {status: 'working', app: 'older-binary'},
	});
});

test('with no daemon running a snapshot file is still read, and no daemon is started', async t => {
	const socketPath = testSocketPath(t);
	const state = testState(t, {
		sqlite: false,
		stateDir: path.dirname(socketPath),
	});
	publishSnapshotFile(state, snapshotOf(target, report('working')));
	const started: string[] = [];
	const client = new StatusClient(socketPath, {
		repo: 'repo',
		timers: manualTimers().timers,
		startDaemon(daemonSocket) {
			started.push(daemonSocket);
		},
	});
	t.teardown(() => {
		client.close();
	});
	const store = createProgramStatusDao({
		repo: 'repo',
		stateDir: state.stateDir,
		socketPath,
		statusClient: client,
	});

	t.like(await store.read('STA-1', pane), {info: {status: 'working'}});
	await store.remove('STA-1');
	t.is(await store.read('STA-1', pane), null);
	t.deepEqual(started, []);
});

test('a monitor’s first send to a connected daemon removes the snapshot file from before the flag was on', async t => {
	const state = testState(t, {sqlite: true});
	const socketPath = statusSocketPath(state.stateDir);
	const h = testPublisher(t, socketPath, {daemonMode: true});
	const before = snapshotOf(target, report('working'), {updatedAt: at});
	publishSnapshotFile(state, before);
	t.true(existsSync(h.file));

	h.publisher.publish(
		snapshotOf(target, report('blocked'), {updatedAt: at + 1000}),
	);

	await waitUntil(() => !existsSync(h.file), 'the file to be removed');
	await sentSoFar(h.clients[0]!, await subscribeRaw(t, socketPath, 'repo'));
	t.is(await readStatus(state, 'STA-1', pane), 'blocked');
	t.true(existsSync(`${h.file}.lease`));
});

test('a monitor that cannot reach a daemon keeps its snapshot file, and sends its latest snapshot once one is there', async t => {
	const socketPath = testSocketPath(t);
	const h = testPublisher(t, socketPath, {daemonMode: false});
	h.grantLease();
	h.publisher.publish(snapshotOf(target, report('working')));
	t.true(existsSync(h.file));

	h.setFlag(true);
	h.advance(1000);
	h.publisher.publish(snapshotOf(target, report('blocked')));
	const latest = snapshotOf(target, report('done'));
	h.publisher.publish(latest);
	await waitUntil(
		() => h.clock.delays().length === 1,
		'the publisher to find no daemon',
	);
	t.is(
		(JSON.parse(readFileSync(h.file, 'utf8')) as ProgramStatusSnapshot).info
			.status,
		'working',
	);

	await serveTestDaemon(t, socketPath);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	h.clock.fire();

	await waitUntil(() => !existsSync(h.file), 'the file to be removed');
	await sentSoFar(h.clients[0]!, rail);
	t.deepEqual(sentStatuses(rail), ['done']);
	t.deepEqual(
		rail.messages.find(message => message.type === 'snapshot'),
		{type: 'snapshot', snapshot: latest},
	);
});

test('a monitor sends its latest snapshot again to a daemon that replaced the first, and nothing once its lease is revoked', async t => {
	const socketPath = testSocketPath(t);
	const first = await serveTestDaemon(t, socketPath);
	const h = testPublisher(t, socketPath, {daemonMode: true});
	h.grantLease();
	h.publisher.publish(snapshotOf(target, report('working')));
	const latest = snapshotOf(target, report('blocked'));
	h.publisher.publish(latest);
	const before = await subscribeRaw(t, socketPath, 'repo');
	await sentSoFar(h.clients[0]!, before);

	await first.close();
	await waitUntil(
		() => h.clock.delays().length === 1,
		'the publisher to see that the daemon went away',
	);
	const second = await serveTestDaemon(t, socketPath);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	h.clock.fire();
	await rail.received(
		message => message.type === 'snapshot',
		'the snapshot sent again',
	);
	await sentSoFar(h.clients[0]!, rail);
	t.deepEqual(sentStatuses(rail), ['blocked']);
	t.deepEqual(rail.messages[1], {type: 'snapshot', snapshot: latest});

	h.revokeLease();
	await second.close();
	await waitUntil(
		() => h.clock.delays().length === 1,
		'the publisher to see that the second daemon went away',
	);
	await serveTestDaemon(t, socketPath);
	const after = await subscribeRaw(t, socketPath, 'repo');
	let connected = false;
	h.clients[0]!.onConnect(() => {
		connected = true;
	});
	h.clock.fire();
	await waitUntil(() => connected, 'the publisher to reconnect');
	await sentSoFar(h.clients[0]!, after);
	t.deepEqual(sentStatuses(after), []);
});

test('a snapshot published after the lease was revoked is not sent', async t => {
	const state = testState(t, {sqlite: true});
	const socketPath = statusSocketPath(state.stateDir);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	const h = testPublisher(t, socketPath, {daemonMode: true});
	h.grantLease();
	h.publisher.publish(snapshotOf(target, report('working')));
	await rail.received(
		message => message.type === 'snapshot',
		'the snapshot published under the lease',
	);

	await state.daos.programStatus.remove('STA-1');
	h.publisher.publish(snapshotOf(target, report('blocked')));

	await sentSoFar(h.clients[0]!, rail);
	t.deepEqual([...new Set(sentStatuses(rail))], ['working']);
	t.true(rail.messages.some(message => message.type === 'forgotten'));
	t.false(existsSync(h.file));
});

// An agent can sit idle for hours. Its monitor publishes nothing in that
// time, so only the liveness check can move its status.
test('an idle monitor moves its snapshot to the daemon on the liveness check after the flag turns on, and back to its file after it turns off', async t => {
	const state = testState(t, {sqlite: true});
	const socketPath = statusSocketPath(state.stateDir);
	const rail = await subscribeRaw(t, socketPath, 'repo');
	const h = testPublisher(t, socketPath, {daemonMode: false});
	h.grantLease();
	const snapshot = snapshotOf(target, report('blocked'));
	h.publisher.publish(snapshot);
	t.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')), snapshot);
	t.is(h.clients.length, 0);

	h.setFlag(true);
	h.advance(5000);
	h.publisher.followFlag();
	await rail.received(
		message => message.type === 'snapshot',
		'the idle pane’s snapshot',
	);
	await waitUntil(() => !existsSync(h.file), 'the file to be removed');
	t.deepEqual(
		rail.messages.find(message => message.type === 'snapshot'),
		{type: 'snapshot', snapshot},
	);

	h.setFlag(false);
	h.advance(5000);
	h.publisher.followFlag();
	t.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')), snapshot);
	t.is(
		await h.clients[0]!.send({type: 'hook', state: hookState('repo-A')}),
		'unreachable',
	);
	// A later snapshot goes to the file, and no connection is opened for it.
	h.publisher.publish(snapshotOf(target, report('done')));
	t.is(
		(JSON.parse(readFileSync(h.file, 'utf8')) as ProgramStatusSnapshot).info
			.status,
		'done',
	);
	t.is(h.clients.length, 1);
});

test('a monitor asks for the flag again once its answer is a second old', async t => {
	const state = testState(t, {sqlite: true});
	const socketPath = statusSocketPath(state.stateDir);
	const h = testPublisher(t, socketPath, {daemonMode: false});
	h.grantLease();
	const fileStatus = () =>
		(JSON.parse(readFileSync(h.file, 'utf8')) as ProgramStatusSnapshot).info
			.status;

	h.publisher.publish(snapshotOf(target, report('working')));
	t.is(fileStatus(), 'working');

	h.setFlag(true);
	h.advance(999);
	h.publisher.publish(snapshotOf(target, report('blocked')));
	h.publisher.followFlag();
	t.is(fileStatus(), 'blocked');
	t.is(h.clients.length, 0);

	h.advance(1);
	h.publisher.publish(snapshotOf(target, report('done')));
	t.is(h.clients.length, 1);
	await waitUntil(() => !existsSync(h.file), 'the file to be removed');
	t.is(h.asked(), 2);
});

/** A connection whose sends the test settles. */
function heldClient() {
	const settles: Array<(result: SendResult) => void> = [];
	let closed = false;
	return {
		settles,
		closed: () => closed,
		client: {
			async send() {
				return new Promise<SendResult>(resolve => {
					settles.push(resolve);
				});
			},
			onConnect: () => () => {},
			close() {
				closed = true;
			},
		},
	};
}

function heldPublisher(t: ExecutionContext) {
	const socketPath = testSocketPath(t);
	const clock = manualTimers();
	const held = heldClient();
	const dir = path.dirname(socketPath);
	writeFileSync(
		`${programStatusPath(dir, target.key, pane.generation)}.lease`,
		'',
	);
	const publisher = followedPublisher({
		dir,
		socketPath,
		daemonMode: () => true,
		timers: clock.timers,
		connect: () => held.client,
	});
	publisher.publish(snapshotOf(target, report('working'), {exited: true}));
	let over = false;
	const closing = publisher.close().then(() => {
		over = true;
	});
	return {clock, held, closing, over: () => over};
}

test('a monitor that is stopping waits for its last snapshot to be written', async t => {
	const h = heldPublisher(t);
	await delay(20);
	t.false(h.over());
	t.false(h.held.closed());

	h.held.settles[0]!('sent');
	await h.closing;

	t.true(h.held.closed());
	t.deepEqual(h.clock.delays(), []);
});

// The monitor of a pane that is gone has nothing else to do, and a daemon
// that is stopped never takes the line.
test('a monitor that is stopping gives up on a daemon that does not take its last snapshot', async t => {
	const h = heldPublisher(t);
	await delay(20);
	t.false(h.over());
	t.deepEqual(h.clock.delays(), [LAST_SEND_WAIT_MS]);

	h.clock.fire();
	await h.closing;

	t.true(h.held.closed());
});

const monitorCli = fileURLToPath(
	new URL('program-status-monitor-cli.ts', import.meta.url),
);
const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.skip;

// start-agent-session.sh waits for `attach`, so an `attach` that stays up
// holds every agent launch. Each part is its own process here, as it is for
// a launched agent: tmux starts the monitor, and the monitor the daemon.
tmuxTest(
	'attach exits with no daemon and with one, the monitor it starts under tmux starts the daemon, and the daemon outlives the monitors',
	async t => {
		t.timeout(120_000);
		const statusSocket = testSocketPath(t);
		const root = path.dirname(statusSocket);
		const tmuxSocket = path.join(root, 'tmux.sock');
		const env = {
			PATH: process.env['PATH'],
			HOME: root,
			SHELL: '/bin/sh',
			// tmux replaces the tabs between the fields attach reads with `_`
			// for a client whose locale is not UTF-8.
			LC_ALL: 'C.UTF-8',
			PAPPARDELLE_SQLITE_STATE: '1',
			PAPPARDELLE_STATE_DB: path.join(root, 'state.db'),
			PAPPARDELLE_PROGRAM_STATUS_DIR: path.join(root, 'status'),
		};
		const tmux = (...args: string[]) =>
			execFileSync('tmux', ['-S', tmuxSocket, ...args], {
				env,
				encoding: 'utf8',
				timeout: 5000,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		const daemons = () => processesNaming('status-daemon-cli', statusSocket);
		const monitors = () =>
			processesNaming('program-status-monitor-cli', ' watch ', statusSocket);
		t.teardown(() => {
			try {
				tmux('kill-server');
			} catch {}

			killProcessesNaming(statusSocket);
		});
		const attach = async (key: string, session: string) => {
			tmux('-f', '/dev/null', 'new-session', '-d', '-s', session, 'cat');
			await execute(
				process.execPath,
				[monitorCli, 'attach', 'repo', key, session, tmuxSocket],
				{env, timeout: 30_000},
			);
		};

		await attach('STA-1', 'agent-1');
		await waitUntil(
			() => existsSync(statusSocket) && daemons().length === 1,
			'the monitor to start a daemon',
			60_000,
		);
		const [daemon] = daemons();
		const rail = await subscribeRaw(t, statusSocket, 'repo');
		const held = (key: string, exited: boolean) =>
			rail.messages.some(message =>
				(message.type === 'state'
					? message.snapshots
					: message.type === 'snapshot'
						? [message.snapshot]
						: []
				).some(snapshot => snapshot.key === key && snapshot.exited === exited),
			);
		await waitUntil(
			() => held('STA-1', false),
			'the first monitor’s snapshot to reach the daemon it started',
			30_000,
		);

		await attach('STA-2', 'agent-2');
		await rail.received(
			message => message.type === 'forgotten' && message.key === 'STA-2',
			'the forget that attach sends for the second space',
		);
		await waitUntil(
			() => held('STA-2', false) && monitors().length === 2,
			'the second monitor’s snapshot',
			30_000,
		);
		t.deepEqual(daemons(), [daemon]);

		tmux('kill-server');
		await waitUntil(
			() => monitors().length === 0,
			'the monitors to exit after their panes died',
			30_000,
		);
		await waitUntil(
			() => held('STA-1', true) && held('STA-2', true),
			'the snapshot each monitor sent as it stopped',
		);
		t.deepEqual(daemons(), [daemon]);
	},
);
