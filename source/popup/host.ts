import {execFile, spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLogger, type LogEntry} from '../logger.ts';
import {
	createMessageDecoder,
	encodeMessage,
	type ChildMessage,
	type HostMessage,
	type PopupSpec,
} from './protocol.ts';
import {popupSize, type ClientSize, type PopupSize} from './size.ts';

const log = createLogger('popup');

export type PopupOutcome = 'confirmed' | 'cancelled' | 'unavailable';

export type PopupHandlers = {
	onConfirm?: () => void | PromiseLike<void>;
	/**
	 * Close the popup before running `onConfirm` rather than showing its
	 * spinner. For actions that take over the TUI's own pane, which the popup
	 * would otherwise cover.
	 */
	closeBeforeConfirm?: boolean;
	onClearErrors?: () => void;
	subscribeErrors?: (push: (errors: LogEntry[]) => void) => () => void;
};

/** The running `tmux display-popup`, reduced to what the host listens for. */
export type PopupProcess = {
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number | null) => void): unknown;
};

export type PopupLaunch = {
	socketPath: string;
	size: PopupSize;
	cwd: string;
};

export type PopupDeps = {
	launch?: (launch: PopupLaunch) => PopupProcess;
	clientSize?: () => Promise<ClientSize>;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
};

const POPUP_CLI = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'popup-cli.js',
);

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildDisplayPopupArgs({
	socketPath,
	size,
	cwd,
}: PopupLaunch): string[] {
	const command = [process.execPath, POPUP_CLI, socketPath]
		.map(arg => shellQuote(arg))
		.join(' ');
	return [
		'display-popup',
		'-B',
		'-E',
		'-w',
		String(size.width),
		'-h',
		String(size.height),
		'-d',
		cwd,
		command,
	];
}

function launchTmuxPopup(launch: PopupLaunch): PopupProcess {
	return spawn('tmux', buildDisplayPopupArgs(launch), {stdio: 'ignore'});
}

async function tmuxClientSize(): Promise<ClientSize> {
	const fallback = {
		cols: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
	};
	return new Promise(resolve => {
		execFile(
			'tmux',
			['display-message', '-p', '#{client_width} #{client_height}'],
			{encoding: 'utf8', timeout: 2000},
			(error, stdout) => {
				const [cols, rows] = stdout.trim().split(' ').map(Number);
				resolve(error || !cols || !rows ? fallback : {cols, rows});
			},
		);
	});
}

export function isPopupAvailable(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return Boolean(env['TMUX']);
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) result[key] = value;
	}

	return result;
}

/**
 * Show a dialog in a tmux popup over the current client and resolve once the
 * user has answered and any action the answer triggered has finished.
 *
 * The popup runs `popup-cli.js`, which renders the dialog with Ink and reports
 * back over a unix socket. Once a confirm or submit handler has started, the
 * popup disappearing does not cut it short: the promise waits for the handler,
 * so a caller that blocks new popups until it resolves never lets a second
 * close overlap one still running its deinit hooks.
 */
export async function openPopup(
	spec: PopupSpec,
	handlers: PopupHandlers = {},
	deps: PopupDeps = {},
): Promise<PopupOutcome> {
	const env = deps.env ?? process.env;
	if (!isPopupAvailable(env)) return 'unavailable';

	const client = await (deps.clientSize ?? tmuxClientSize)();
	const dir = mkdtempSync(path.join(tmpdir(), 'pappardelle-popup-'));
	const socketPath = path.join(dir, 's.sock');

	let popupExited: () => void = () => {};
	const popupGone = new Promise<void>(resolve => {
		popupExited = resolve;
	});

	return new Promise<PopupOutcome>(resolve => {
		let settled = false;
		let connected = false;
		let socket: Socket | undefined;
		let running: Promise<PopupOutcome> | undefined;
		let unsubscribeErrors: (() => void) | undefined;

		const server = createServer();

		const finish = (outcome: PopupOutcome) => {
			if (settled) return;
			settled = true;
			unsubscribeErrors?.();
			server.close();
			rmSync(dir, {recursive: true, force: true});
			resolve(outcome);
		};

		const send = (message: HostMessage) => {
			if (socket && !socket.destroyed) socket.write(encodeMessage(message));
		};

		const run = (
			outcome: PopupOutcome,
			action: () => void | PromiseLike<void>,
		) => {
			running ??= (async () => {
				try {
					await action();
				} catch (error) {
					log.error(
						'Popup action failed',
						error instanceof Error ? error : undefined,
					);
				}

				send({type: 'done'});
				return outcome;
			})();
			void running.then(finish);
		};

		const handle = (message: ChildMessage) => {
			switch (message.type) {
				case 'confirm': {
					const onConfirm = handlers.onConfirm ?? (() => {});
					if (handlers.closeBeforeConfirm) {
						running ??= (async () => {
							send({type: 'done'});
							await popupGone;
							await onConfirm();
							return 'confirmed' as const;
						})();
						void running.then(finish);
					} else {
						run('confirmed', onConfirm);
					}

					break;
				}

				case 'clear-errors': {
					run('confirmed', () => handlers.onClearErrors?.());
					break;
				}

				case 'cancel': {
					if (!running) finish('cancelled');
					break;
				}
			}
		};

		const onSocketClosed = () => {
			if (!running) finish('cancelled');
		};

		const onPopupExited = () => {
			popupExited();
			if (!running) finish(connected ? 'cancelled' : 'unavailable');
		};

		server.on('connection', connection => {
			if (connected) {
				connection.destroy();
				return;
			}

			connected = true;
			socket = connection;
			connection.on('data', createMessageDecoder<ChildMessage>(handle));
			connection.on('error', () => {});
			connection.on('close', onSocketClosed);
			send({
				type: 'init',
				env: stringEnv(env),
				cwd: deps.cwd ?? process.cwd(),
				...spec,
			} as HostMessage);
			if (handlers.subscribeErrors) {
				unsubscribeErrors = handlers.subscribeErrors(errors => {
					send({type: 'errors', errors});
				});
			}
		});

		server.on('error', error => {
			log.warn('Popup socket failed', error);
			finish('unavailable');
		});

		server.listen(socketPath, () => {
			let popup: PopupProcess;
			try {
				popup = (deps.launch ?? launchTmuxPopup)({
					socketPath,
					size: popupSize(spec, client),
					cwd: deps.cwd ?? process.cwd(),
				});
			} catch (error) {
				log.warn(
					'display-popup failed',
					error instanceof Error ? error : undefined,
				);
				finish('unavailable');
				return;
			}

			popup.on('error', error => {
				log.warn('display-popup failed', error);
				onPopupExited();
			});
			popup.on('exit', onPopupExited);
		});
	});
}
