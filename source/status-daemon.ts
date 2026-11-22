// The status daemon: one process per user that holds every repo's hook status
// and program status in memory and pushes each change to the rails.

import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import {withFileLock} from './file-lock.ts';
import {createLogger} from './logger.ts';
import {StatusHub, type Delivery} from './status-hub.ts';
import {
	LineReader,
	backgroundTimers,
	encodeMessage,
	parseClientMessage,
	type DaemonMessage,
	type StatusTimers,
} from './status-protocol.ts';

const log = createLogger('status-daemon');

/**
 * How long the daemon stays after its last connection closes. Pane monitors
 * stay connected for as long as their agents run, so the daemon lasts as long
 * as any agent does and across a restart of the TUI.
 */
export const IDLE_EXIT_MS = 10_000;

/**
 * A subscriber with more than this waiting to be read is disconnected, and
 * gets a fresh state when it reconnects. A stopped TUI process would
 * otherwise have the daemon keep 40 monitors' output for it without bound.
 */
export const MAX_SUBSCRIBER_BACKLOG_BYTES = 8 * 1024 * 1024;

const SOCKET_MODE = 0o600;
const LOGGED_LINE_LENGTH = 200;

export type StatusDaemon = {
	/** Settles once the daemon has stopped listening, whatever stopped it. */
	closed: Promise<void>;
	close(): Promise<void>;
};

export type StatusDaemonStart =
	| {kind: 'serving'; daemon: StatusDaemon}
	/** Another daemon answers on the socket. */
	| {kind: 'already-served'}
	/** The socket cannot be listened on. The reason is logged. */
	| {kind: 'failed'};

export type StatusDaemonOptions = {
	timers?: StatusTimers;
	/** Runs between finding no daemon on the socket and listening on it. */
	beforeListen?: () => Promise<void>;
};

async function answers(socketPath: string): Promise<boolean> {
	return new Promise(resolve => {
		const probe = net.connect(socketPath);
		probe.once('connect', () => {
			probe.destroy();
			resolve(true);
		});
		probe.once('error', () => {
			resolve(false);
		});
	});
}

export type StatusServer = {
	server: net.Server;
	connections: ReadonlySet<net.Socket>;
	disconnectAll(): void;
};

/**
 * A server, not yet listening, that keeps one hub: each line a connection
 * sends is applied to it, and what the hub returns is written to its
 * subscribers.
 */
export function createStatusServer(
	on: {opened?: () => void; closed?: () => void} = {},
): StatusServer {
	const hub = new StatusHub<net.Socket>(randomUUID());
	const connections = new Set<net.Socket>();

	const disconnect = (connection: net.Socket) => {
		hub.disconnect(connection);
		connection.destroy();
	};

	const send = (deliveries: Array<Delivery<net.Socket>>) => {
		let encoded: {message: DaemonMessage; line: string} | undefined;
		for (const {to, message} of deliveries) {
			if (encoded?.message !== message)
				encoded = {message, line: encodeMessage(message)};
			to.write(encoded.line);
			if (to.writableLength > MAX_SUBSCRIBER_BACKLOG_BYTES) {
				log.warn('Disconnected a subscriber that stopped reading');
				disconnect(to);
			}
		}
	};

	const server = net.createServer(connection => {
		connections.add(connection);
		on.opened?.();
		const reader = new LineReader();
		let invalidLogged = false;
		connection.setEncoding('utf8');
		connection.on('data', (text: string) => {
			for (const line of reader.feed(text)) {
				const parsed = parseClientMessage(line);
				if (parsed.kind === 'message') {
					send(hub.receive(connection, parsed.message));
				} else if (!invalidLogged) {
					invalidLogged = true;
					log.warn(
						`Ignored a line that is not a status message: ${line.slice(0, LOGGED_LINE_LENGTH)}`,
					);
				}
			}
		});
		connection.on('error', error => {
			log.debug(`Connection failed: ${error.message}`);
		});
		connection.on('close', () => {
			connections.delete(connection);
			hub.disconnect(connection);
			on.closed?.();
		});
	});

	return {
		server,
		connections,
		disconnectAll() {
			for (const connection of connections) disconnect(connection);
		},
	};
}

/**
 * Serve status on `socketPath` unless a daemon already does. Every step that
 * creates or removes the socket file runs under the same file lock, which is
 * what keeps two daemons started together from each replacing the other's
 * socket.
 */
export async function serveStatusDaemon(
	socketPath: string,
	options: StatusDaemonOptions = {},
): Promise<StatusDaemonStart> {
	const timers = options.timers ?? backgroundTimers;
	let arrivals = 0;
	let stopped = false;
	let cancelIdleExit: (() => void) | undefined;
	let markClosed!: () => void;
	const closed = new Promise<void>(resolve => {
		markClosed = resolve;
	});

	const stop = () => {
		if (stopped) return;
		stopped = true;
		cancelIdleExit?.();
		server.close();
		fs.rmSync(socketPath, {force: true});
		disconnectAll();
		markClosed();
	};

	const exitIfIdle = async () => {
		const seen = arrivals;
		try {
			await withFileLock(socketPath, () => {
				// A connection that came and went while this waited for the lock
				// has started the idle wait again.
				if (connections.size === 0 && arrivals === seen) stop();
			});
		} catch (error) {
			log.warn('Cannot take the lock to stop when idle', error as Error);
			armIdleExit();
		}
	};

	const armIdleExit = () => {
		cancelIdleExit = timers.after(IDLE_EXIT_MS, () => {
			void exitIfIdle();
		});
	};

	const {server, connections, disconnectAll} = createStatusServer({
		opened() {
			arrivals++;
			cancelIdleExit?.();
		},
		closed() {
			if (connections.size === 0 && !stopped) armIdleExit();
		},
	});

	const listen = async () =>
		new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(socketPath, () => {
				server.off('error', reject);
				server.on('error', error => {
					log.error('Status daemon socket failed', error);
				});
				resolve();
			});
		});

	try {
		return await withFileLock(
			socketPath,
			async (): Promise<StatusDaemonStart> => {
				if (await answers(socketPath)) return {kind: 'already-served'};
				await options.beforeListen?.();
				fs.rmSync(socketPath, {force: true});
				await listen();
				fs.chmodSync(socketPath, SOCKET_MODE);
				armIdleExit();
				return {
					kind: 'serving',
					daemon: {
						closed,
						async close() {
							await withFileLock(socketPath, stop);
						},
					},
				};
			},
		);
	} catch (error) {
		log.error(`Cannot listen on ${socketPath}`, error as Error);
		return {kind: 'failed'};
	}
}
