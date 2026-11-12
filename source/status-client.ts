// A process's connection to the status daemon: a copy of the daemon's state
// kept current by its pushes, and the way to send it status.

import {spawn} from 'node:child_process';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import type {ClaudeSessionState} from './claude-status.ts';
import {createLogger} from './logger.ts';
import type {ProgramStatusSnapshot} from './program-status-monitor.ts';
import {bunIsolationArgs, isStandalone} from './runtime.ts';
import {
	LineReader,
	backgroundTimers,
	encodeMessage,
	parseDaemonMessage,
	type ClientMessage,
	type DaemonMessage,
	type StatusTimers,
} from './status-protocol.ts';

const log = createLogger('status-client');

// The wait before a connection attempt: nothing after a lost connection, then
// doubling from the base for each attempt that fails, plus a random part.
const RECONNECT_BASE_MS = 100;
const RECONNECT_MAX_MS = 5000;
/**
 * When a daemon dies, every pane monitor loses it in the same moment. Spread
 * over this long, most of them find the daemon the first one started instead
 * of each starting one.
 */
const RECONNECT_SPREAD_MS = 400;
/**
 * How long `ready()` waits for the state of a daemon that accepted the
 * connection. A daemon that is stopped accepts and never answers, and every
 * CLI verb and the rail's first frame wait on `ready()`.
 */
export const STATE_WAIT_MS = 500;

export type StatusChange =
	| {kind: 'hook'; statusKey: string}
	| {kind: 'snapshot'; key: string};

export type SendResult = 'sent' | 'unreachable';

export type StatusClientOptions = {
	/**
	 * The repo whose snapshots to follow, with every repo's hook status. A
	 * client without one only sends, and is pushed nothing.
	 */
	repo?: string;
	/** Start a daemon when none listens. Only a TUI and a pane monitor do. */
	start?: boolean;
	timers?: StatusTimers;
	/** In [0, 1): the share of the spread to wait before an attempt. */
	random?: () => number;
	startDaemon?: (socketPath: string) => void;
};

function daemonCommand(): string[] {
	if (isStandalone) return [process.execPath, '--internal-status-daemon'];
	const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
	const entry = fileURLToPath(
		new URL(`status-daemon-cli${extension}`, import.meta.url),
	);
	return [process.execPath, ...bunIsolationArgs, entry];
}

/**
 * Start a daemon that outlives this process. It exits by itself when another
 * already serves the socket.
 */
export function spawnStatusDaemon(
	socketPath: string,
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	const [command, ...args] = daemonCommand();
	const daemon = spawn(command!, [...args, socketPath], {
		detached: true,
		stdio: 'ignore',
		env,
	});
	daemon.on('error', error => {
		log.warn('Cannot start the status daemon', error);
	});
	daemon.unref();
	return daemon.pid;
}

/** Resolve at the first change `watch` reports, or after `ms`. */
export async function firstChange(
	watch: (listener: () => void) => () => void,
	ms: number,
): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(done, ms);
		const stop = watch(done);
		function done() {
			clearTimeout(timer);
			stop();
			resolve();
		}
	});
}

const nobodyListens = (error: NodeJS.ErrnoException) =>
	error.code === 'ECONNREFUSED' || error.code === 'ENOENT';

export class StatusClient {
	private hooks = new Map<string, ClaudeSessionState>();
	/** By space key, then pane generation. */
	private snapshots = new Map<string, Map<string, ProgramStatusSnapshot>>();
	private readonly changeListeners = new Set<(change: StatusChange) => void>();
	private readonly connectListeners = new Set<() => void>();

	private link: 'unused' | 'connecting' | 'connected' | 'waiting' | 'closed' =
		'unused';

	private socket: net.Socket | undefined;
	/** Whether the attempt in progress connected. */
	private connecting: Promise<boolean> = Promise.resolve(false);
	private firstAttempt: Promise<void> | undefined;
	private failedAttempts = 0;
	/** Refused attempts, while allowed to start a daemon, since a connection. */
	private refusalsSinceConnected = 0;
	private cancelRetry: (() => void) | undefined;
	/** Calls in progress that the process must stay alive to finish. */
	private inProgress = 0;

	private readonly repo: string | undefined;
	private start: boolean;
	private readonly timers: StatusTimers;
	private readonly random: () => number;
	private readonly startDaemon: (socketPath: string) => void;

	constructor(
		private readonly socketPath: string,
		options: StatusClientOptions = {},
	) {
		this.repo = options.repo;
		this.start = options.start ?? false;
		this.timers = options.timers ?? backgroundTimers;
		this.random = options.random ?? Math.random;
		this.startDaemon = options.startDaemon ?? spawnStatusDaemon;
	}

	/** From now on, start a daemon when none listens. */
	allowStart(): void {
		this.start = true;
	}

	/**
	 * Settles once the first connection attempt is over: with the daemon's
	 * state in the replica, or with an empty replica when nothing listens or
	 * the daemon has not answered within STATE_WAIT_MS. It never waits for a
	 * daemon to start. A state that arrives later is told to the listeners.
	 */
	async ready(): Promise<void> {
		this.use();
		await this.firstAttempt;
	}

	hook(statusKey: string): ClaudeSessionState | undefined {
		return this.hooks.get(statusKey);
	}

	snapshot(key: string, generation: string): ProgramStatusSnapshot | undefined {
		return this.snapshots.get(key)?.get(generation);
	}

	/**
	 * Call `listener` for each record the daemon pushes. After a reconnect
	 * that is every key the replica holds, since anything may have changed
	 * while the connection was down.
	 */
	onChange(listener: (change: StatusChange) => void): () => void {
		this.use();
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	/**
	 * Call `listener` each time a connection is made. A new daemon knows
	 * nothing, so a publisher sends its latest status again from here.
	 */
	onConnect(listener: () => void): () => void {
		this.connectListeners.add(listener);
		return () => {
			this.connectListeners.delete(listener);
		};
	}

	/**
	 * `sent` once the line is written to a connected socket. Nothing is queued
	 * for a daemon that cannot be reached.
	 */
	async send(message: ClientMessage): Promise<SendResult> {
		this.use();
		this.hold();
		try {
			if (this.link === 'connecting') await this.connecting;
			if (this.link !== 'connected') return 'unreachable';
			const socket = this.socket!;
			return await new Promise<SendResult>(resolve => {
				socket.write(encodeMessage(message), error => {
					resolve(error ? 'unreachable' : 'sent');
				});
			});
		} finally {
			this.release();
		}
	}

	close(): void {
		this.link = 'closed';
		this.cancelRetry?.();
		this.socket?.destroy();
		this.changeListeners.clear();
		this.connectListeners.clear();
	}

	private use(): void {
		if (this.link !== 'unused') return;
		this.hold();
		this.firstAttempt = this.connect().then(() => {
			this.release();
		});
	}

	// A connected socket keeps its process alive. A CLI verb has to exit when
	// its work is done, so the socket counts only while a call waits on it.
	private hold(): void {
		this.inProgress++;
		this.keepAliveWhileInProgress();
	}

	private release(): void {
		this.inProgress--;
		this.keepAliveWhileInProgress();
	}

	private keepAliveWhileInProgress(): void {
		if (this.link !== 'connected') return;
		if (this.inProgress > 0) this.socket!.ref();
		else this.socket!.unref();
	}

	/**
	 * Settles when the attempt is over: the replica holds the daemon's state
	 * (a client with no repo: the socket is connected), the daemon has not
	 * sent it in time, or the attempt failed.
	 */
	private async connect(): Promise<void> {
		const socket = net.connect(this.socketPath);
		this.socket = socket;
		this.link = 'connecting';
		const reader = new LineReader();
		let connected = false;
		let over = false;
		let invalidLogged = false;
		let settleConnecting!: (connected: boolean) => void;
		this.connecting = new Promise(resolve => {
			settleConnecting = resolve;
		});
		let cancelStateWait: (() => void) | undefined;
		let resolveAttempt!: () => void;
		const attempt = new Promise<void>(resolve => {
			resolveAttempt = resolve;
		});
		const settleAttempt = () => {
			cancelStateWait?.();
			resolveAttempt();
		};

		const end = () => {
			if (over) return;
			over = true;
			settleConnecting(false);
			settleAttempt();
			if (this.link === 'closed') return;
			if (connected) {
				this.failedAttempts = 0;
				this.refusalsSinceConnected = 0;
			} else {
				this.failedAttempts++;
			}

			this.retryLater();
		};

		socket.setEncoding('utf8');
		socket.on('connect', () => {
			connected = true;
			this.link = 'connected';
			this.keepAliveWhileInProgress();
			settleConnecting(true);
			if (this.repo === undefined) {
				settleAttempt();
			} else {
				socket.write(encodeMessage({type: 'subscribe', repo: this.repo}));
				cancelStateWait = this.timers.after(STATE_WAIT_MS, settleAttempt);
			}

			for (const listener of this.connectListeners) listener();
		});
		// Also what notices a daemon that went away: a socket nobody reads
		// from is never told that its peer closed.
		socket.on('data', (text: string) => {
			for (const line of reader.feed(text)) {
				const parsed = parseDaemonMessage(line);
				if (parsed.kind === 'message') {
					this.apply(parsed.message);
					if (parsed.message.type === 'state') settleAttempt();
				} else if (!invalidLogged) {
					invalidLogged = true;
					log.warn(
						'Ignored a line from the status daemon that is not a message',
					);
				}
			}
		});
		socket.on('error', (error: NodeJS.ErrnoException) => {
			if (!connected && this.start && nobodyListens(error))
				this.startDaemonIfDue();
			end();
		});
		socket.on('close', end);
		return attempt;
	}

	/**
	 * A daemon that cannot listen (a directory it may not write to, a socket
	 * path too long) exits each time it is started. Starting one on the first
	 * refusal and then on every doubling of the count keeps 40 monitors from
	 * starting one each every few seconds for as long as that lasts.
	 */
	private startDaemonIfDue(): void {
		this.refusalsSinceConnected++;
		const count = this.refusalsSinceConnected;
		// eslint-disable-next-line no-bitwise
		if ((count & (count - 1)) === 0) this.startDaemon(this.socketPath);
	}

	private retryLater(): void {
		const backoff =
			this.failedAttempts === 0
				? 0
				: Math.min(
						RECONNECT_BASE_MS * 2 ** (this.failedAttempts - 1),
						RECONNECT_MAX_MS,
					);
		this.link = 'waiting';
		this.cancelRetry = this.timers.after(
			backoff + this.random() * RECONNECT_SPREAD_MS,
			() => {
				void this.connect();
			},
		);
	}

	private apply(message: DaemonMessage): void {
		switch (message.type) {
			case 'state': {
				const known = {hooks: this.hooks, snapshots: this.snapshots};
				this.hooks = new Map();
				this.snapshots = new Map();
				for (const state of message.hooks)
					this.hooks.set(state.workspaceName, state);
				for (const snapshot of message.snapshots) this.keep(snapshot);

				// A daemon that replaced another holds nothing. Each monitor
				// sends its snapshot again within a second, but an agent's hook
				// status would be unknown until its next event, and an agent
				// waiting for approval has none until a person acts. So what
				// this process knew stays, and the daemon is sent the hook
				// records it lacks.
				const unknownToDaemon: ClaudeSessionState[] = [];
				for (const [statusKey, state] of known.hooks) {
					const held = this.hooks.get(statusKey);
					if (held && held.lastUpdate >= state.lastUpdate) continue;
					this.hooks.set(statusKey, state);
					unknownToDaemon.push(state);
				}

				for (const generations of known.snapshots.values()) {
					for (const snapshot of generations.values()) {
						if (!this.snapshot(snapshot.key, snapshot.pane.generation))
							this.keep(snapshot);
					}
				}

				for (const statusKey of this.hooks.keys())
					this.tell({kind: 'hook', statusKey});
				for (const key of this.snapshots.keys())
					this.tell({kind: 'snapshot', key});
				for (const state of unknownToDaemon)
					this.socket?.write(encodeMessage({type: 'restore', state}));
				break;
			}

			case 'hook': {
				this.hooks.set(message.state.workspaceName, message.state);
				this.tell({kind: 'hook', statusKey: message.state.workspaceName});
				break;
			}

			case 'snapshot': {
				this.keep(message.snapshot);
				this.tell({kind: 'snapshot', key: message.snapshot.key});
				break;
			}

			case 'forgotten': {
				const generations = this.snapshots.get(message.key);
				for (const generation of generations?.keys() ?? []) {
					if (generation !== message.keep) generations!.delete(generation);
				}

				this.tell({kind: 'snapshot', key: message.key});
				break;
			}
		}
	}

	private keep(snapshot: ProgramStatusSnapshot): void {
		const generations = this.snapshots.get(snapshot.key) ?? new Map();
		generations.set(snapshot.pane.generation, snapshot);
		this.snapshots.set(snapshot.key, generations);
	}

	private tell(change: StatusChange): void {
		for (const listener of this.changeListeners) listener(change);
	}
}
