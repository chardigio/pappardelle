// JSON-RPC client for herdr-core ("hc"), the terminal runtime that keeps
// programs alive in terminals of its own, and for the herdr session server
// that arranges those terminals into workspaces, tabs and panes.
//
// Two endpoints matter:
//   - herdr-core: `$HC_TERMINAL_SOCKET` (default ~/.local/state/herdr-core/
//     default/default.sock). One message per line, JSON-RPC 2.0, generation 1.
//     Terminals live here: run, send, keys, read, kill, labels.
//   - herdr: ~/.config/herdr/herdr.sock. Layout lives here: workspaces, tabs,
//     panes. Each pane is backed by an hc terminal.
//
// Both accept the same line-delimited JSON-RPC shape, so one connection class
// serves them; only the socket path and method names differ.

import {connect, type Socket} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';

export type HerdrErrorKind =
	| 'not_found'
	| 'name_taken'
	| 'invalid_params'
	| 'unavailable'
	| 'blocked'
	| 'finished'
	| 'machine_unknown'
	| 'server_not_running'
	| string;

/** A failed RPC, carrying the stable `kind` the server documents. */
export class HerdrRpcError extends Error {
	readonly kind: HerdrErrorKind;
	readonly method: string;

	constructor(method: string, kind: HerdrErrorKind, message: string) {
		super(`herdr ${method} failed (${kind}): ${message}`);
		this.name = 'HerdrRpcError';
		this.kind = kind;
		this.method = method;
	}
}

/** `true` when the failure is only that the thing asked about is absent. */
export function isHerdrMissing(error: unknown): boolean {
	return (
		error instanceof HerdrRpcError &&
		(error.kind === 'not_found' ||
			error.kind === 'finished' ||
			error.kind === 'server_not_running')
	);
}

export type HerdrSocket = 'core' | 'session';

/**
 * Where each server keeps its socket. `HC_TERMINAL_SOCKET` lets a caller point
 * at an isolated core (tests, a second machine's core over a tunnel); without
 * it the standard per-user path applies.
 */
export function herdrSocketPath(
	which: HerdrSocket,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (which === 'core') {
		return (
			env['HC_TERMINAL_SOCKET'] ??
			join(
				homedir(),
				'.local',
				'state',
				'herdr-core',
				'default',
				'default.sock',
			)
		);
	}

	return (
		env['HERDR_SOCKET'] ?? join(homedir(), '.config', 'herdr', 'herdr.sock')
	);
}

type Pending = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A line-delimited JSON-RPC connection. Requests are written whole and their
 * answers matched by id; a dropped connection rejects everything in flight so
 * a caller never waits on a server that has gone.
 */
export class HerdrConnection {
	private socket: Socket | null = null;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	private closed: Error | null = null;

	constructor(
		readonly path: string,
		private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
	) {}

	/** Connect once; later calls reuse the open socket. */
	async open(): Promise<void> {
		if (this.socket) return;
		if (this.closed) throw this.closed;

		const socket = connect(this.path);
		socket.setEncoding('utf8');
		this.socket = socket;

		socket.on('data', (chunk: string) => {
			this.receive(chunk);
		});
		socket.on('error', error => {
			this.failAll(
				new HerdrRpcError('connect', 'server_not_running', error.message),
			);
		});
		socket.on('close', () => {
			this.failAll(
				new HerdrRpcError(
					'connect',
					'server_not_running',
					`${this.path} closed`,
				),
			);
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				socket.off('connect', onConnect);
				reject(
					new HerdrRpcError('connect', 'server_not_running', error.message),
				);
			};

			const onConnect = () => {
				socket.off('error', onError);
				resolve();
			};

			socket.once('connect', onConnect);
			socket.once('error', onError);
		});
	}

	close(): void {
		this.socket?.end();
		this.socket = null;
		this.closed = new HerdrRpcError(
			'close',
			'server_not_running',
			'connection closed by caller',
		);
	}

	async call<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<T> {
		await this.open();
		const {socket} = this;
		if (!socket) {
			throw new HerdrRpcError(method, 'server_not_running', 'no socket');
		}

		const id = `ppd-${this.nextId++}`;
		const answer = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new HerdrRpcError(
						method,
						'unavailable',
						`timed out after ${this.timeoutMs}ms`,
					),
				);
			}, this.timeoutMs);

			this.pending.set(id, {resolve, reject, timer});
		});

		socket.write(`${JSON.stringify({id, method, params})}\n`);
		return answer;
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const index = this.buffer.indexOf('\n');
			if (index === -1) return;
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim()) this.dispatch(line);
		}
	}

	private dispatch(line: string): void {
		let message: {
			id?: string;
			result?: unknown;
			error?: {
				code?: string | number;
				message?: string;
				data?: {kind?: string};
			};
		};

		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		// Notifications (events, heartbeats) carry no id and are ignored here;
		// the layout code polls instead of subscribing.
		if (message.id === undefined) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;

		this.pending.delete(message.id);
		clearTimeout(pending.timer);

		if (message.error) {
			const kind =
				message.error.data?.kind ??
				(typeof message.error.code === 'string'
					? message.error.code
					: String(message.error.code ?? 'unavailable'));
			pending.reject(
				new HerdrRpcError(
					'call',
					kind,
					message.error.message ?? 'unknown error',
				),
			);
			return;
		}

		pending.resolve(message.result);
	}

	private failAll(error: Error): void {
		this.closed = error;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}

		this.pending.clear();
		this.socket = null;
	}
}

/** The core connection the process shares, opened on first use. */
let coreConnection: HerdrConnection | null = null;
let sessionConnection: HerdrConnection | null = null;

export function coreClient(): HerdrConnection {
	coreConnection ??= new HerdrConnection(herdrSocketPath('core'));
	return coreConnection;
}

export function sessionClient(): HerdrConnection {
	sessionConnection ??= new HerdrConnection(herdrSocketPath('session'));
	return sessionConnection;
}

/** Drop both connections, so a test or a retry reconnects cleanly. */
export function resetHerdrConnections(): void {
	coreConnection?.close();
	sessionConnection?.close();
	coreConnection = null;
	sessionConnection = null;
}
