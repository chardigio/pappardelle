import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
	ClaudeSessionState,
	ClaudeStatus,
} from '../../source/claude-status.ts';
import type {StatusPane} from '../../source/program-status-monitor.ts';
import {
	serveStatusDaemon,
	type StatusDaemon,
	type StatusDaemonOptions,
} from '../../source/status-daemon.ts';
import {
	LineReader,
	encodeMessage,
	parseDaemonMessage,
	type ClientMessage,
	type DaemonMessage,
	type StatusTimers,
} from '../../source/status-protocol.ts';
import {waitUntil} from './wait.ts';

type Teardown = {teardown(fn: () => void | Promise<void>): unknown};

/** Timers that run only when a test fires them. */
export function manualTimers(): {
	timers: StatusTimers;
	/** The delays asked for and not yet fired or cancelled. */
	delays(): number[];
	/** Run what is waiting, as if every delay had passed. */
	fire(): void;
} {
	let waiting: Array<{ms: number; run: () => void}> = [];
	return {
		timers: {
			after(ms, run) {
				const entry = {ms, run};
				waiting.push(entry);
				return () => {
					waiting = waiting.filter(other => other !== entry);
				};
			},
		},
		delays: () => waiting.map(entry => entry.ms),
		fire() {
			const due = waiting;
			waiting = [];
			for (const entry of due) entry.run();
		},
	};
}

/**
 * A socket path in a directory of the test's own. Unix socket paths are
 * limited to about 104 bytes, so the directory name is kept short.
 */
export function testSocketPath(t: Teardown): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-sd-'));
	t.teardown(() => {
		fs.rmSync(directory, {recursive: true, force: true});
	});
	return path.join(directory, 'status-1.sock');
}

/** A daemon in this process, closed when the test ends. */
export async function serveTestDaemon(
	t: Teardown,
	socketPath: string,
	options: StatusDaemonOptions = {},
): Promise<StatusDaemon> {
	const start = await serveStatusDaemon(socketPath, {
		timers: manualTimers().timers,
		...options,
	});
	if (start.kind !== 'serving')
		throw new Error(`The test daemon did not start: ${start.kind}`);
	t.teardown(async () => start.daemon.close());
	return start.daemon;
}

export type RawConnection = {
	socket: net.Socket;
	/** What the daemon has sent, in order. */
	messages: DaemonMessage[];
	send(message: ClientMessage): void;
	/** Resolves once the daemon has sent a message that `matches`. */
	received(
		matches: (message: DaemonMessage) => boolean,
		what: string,
	): Promise<void>;
};

/** A socket to the daemon that speaks the protocol and nothing more. */
export async function connectRaw(
	t: Teardown,
	socketPath: string,
): Promise<RawConnection> {
	const socket = net.connect(socketPath);
	const reader = new LineReader();
	const messages: DaemonMessage[] = [];
	socket.setEncoding('utf8');
	socket.on('data', (text: string) => {
		for (const line of reader.feed(text)) {
			const parsed = parseDaemonMessage(line);
			if (parsed.kind === 'message') messages.push(parsed.message);
		}
	});
	socket.on('error', () => {});
	t.teardown(() => {
		socket.destroy();
	});
	await new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('error', reject);
	});
	return {
		socket,
		messages,
		send(message) {
			socket.write(encodeMessage(message));
		},
		async received(matches, what) {
			await waitUntil(() => messages.some(message => matches(message)), what);
		},
	};
}

/** A subscriber that has received the daemon's state. */
export async function subscribeRaw(
	t: Teardown,
	socketPath: string,
	repo: string,
): Promise<RawConnection> {
	const connection = await connectRaw(t, socketPath);
	connection.send({type: 'subscribe', repo});
	await connection.received(
		message => message.type === 'state',
		`the state of ${repo}`,
	);
	return connection;
}

export function hookState(
	workspaceName: string,
	status: ClaudeStatus = 'processing',
): ClaudeSessionState {
	return {sessionId: 'session', workspaceName, status, lastUpdate: 1000};
}

export function testPane(generation: string): StatusPane {
	return {
		id: '%1',
		pid: '100',
		dead: false,
		piped: true,
		marker: '',
		generation,
	};
}
