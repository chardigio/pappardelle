import {execFile, spawn} from 'node:child_process';
import {createLogger, type LogEntry} from '../logger.ts';
import {presentPopup} from './present.tsx';
import type {ConfirmPayload, PopupActions, PopupSpec} from './spec.ts';
import {popupSize, type ClientSize, type PopupSize} from './size.ts';
import {openPopupTerminal, type PopupTerminal} from './terminal.ts';

const log = createLogger('popup');

export type PopupOutcome = 'confirmed' | 'cancelled' | 'unavailable';

export type PopupHandlers = {
	onConfirm?: (payload?: ConfirmPayload) => void | PromiseLike<void>;
	/**
	 * Close the popup before running `onConfirm` rather than showing its
	 * spinner. For actions that take over the TUI's own pane, which the popup
	 * would otherwise cover.
	 */
	closeBeforeConfirm?: boolean;
	onClearErrors?: () => void;
	subscribeErrors?: (push: (errors: LogEntry[]) => void) => () => void;
};

/** A popup on screen. */
export type ShownPopup = {
	/** Resolves once the popup has closed, whoever closed it. */
	closed: Promise<void>;
	close: () => void;
};

/**
 * Put the dialog on screen, answering through `actions`, or resolve undefined
 * when the popup could not be shown.
 */
export type ShowPopup = (
	spec: PopupSpec,
	size: PopupSize,
	actions: PopupActions,
) => Promise<ShownPopup | undefined>;

export type PopupDeps = {
	show?: ShowPopup;
	clientSize?: () => Promise<ClientSize>;
	env?: NodeJS.ProcessEnv;
};

const showInTmux: ShowPopup = async (spec, size, actions) => {
	let terminal: PopupTerminal | undefined;
	try {
		terminal = await openPopupTerminal(size);
		if (!terminal) return undefined;
		return {
			closed: terminal.closed,
			close: presentPopup(spec, actions, terminal),
		};
	} catch (error) {
		terminal?.close();
		log.warn(
			'Popup failed to open',
			error instanceof Error ? error : undefined,
		);
		return undefined;
	}
};

/**
 * Run a shell command in a tmux popup over the TUI, sized for an interactive
 * program such as claude. A failing command keeps the popup open so its error
 * can be read. The popup's shell starts from the tmux server's environment,
 * so PATH is passed along for a command installed where only the TUI's
 * environment finds it. Resolves with the command's exit code.
 */
export async function runCommandPopup(
	command: string,
	{cwd, title}: {cwd: string; title: string},
): Promise<number | undefined> {
	return new Promise(resolve => {
		const popup = spawn(
			'tmux',
			[
				'display-popup',
				'-EE',
				'-w',
				'90%',
				'-h',
				'90%',
				'-T',
				title,
				'-d',
				cwd,
				'-e',
				`PATH=${process.env['PATH'] ?? ''}`,
				command,
			],
			{stdio: 'ignore'},
		);
		popup.on('error', error => {
			log.warn(`Popup for ${title} failed to open`, error);
			resolve(undefined);
		});
		popup.on('exit', code => {
			resolve(code ?? undefined);
		});
	});
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

/**
 * Show a dialog in a tmux popup over the current client and resolve once the
 * user has answered and any action the answer triggered has finished.
 *
 * The TUI process renders the dialog into the popup's terminal itself. Once a
 * confirm or clear has started, the popup disappearing does not cut it short:
 * the promise waits for the handler, so a caller that blocks new popups until
 * it resolves never lets a second close overlap one still running its deinit
 * hooks.
 */
export async function openPopup(
	spec: PopupSpec,
	handlers: PopupHandlers = {},
	deps: PopupDeps = {},
): Promise<PopupOutcome> {
	if (!isPopupAvailable(deps.env)) return 'unavailable';

	const client = await (deps.clientSize ?? tmuxClientSize)();

	return new Promise<PopupOutcome>(resolve => {
		let settled = false;
		let running: Promise<PopupOutcome> | undefined;
		let popup: ShownPopup | undefined;
		let closeRequested = false;
		let markPopupClosed: () => void = () => {};
		const popupClosed = new Promise<void>(resolve => {
			markPopupClosed = resolve;
		});

		const finish = (outcome: PopupOutcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};

		const closePopup = () => {
			closeRequested = true;
			popup?.close();
		};

		const run = async (
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

				return outcome;
			})();
			finish(await running);
			closePopup();
		};

		const actions: PopupActions = {
			async confirm(payload) {
				const onConfirm = async () => handlers.onConfirm?.(payload);
				await run(
					'confirmed',
					handlers.closeBeforeConfirm
						? async () => {
								closePopup();
								await popupClosed;
								await onConfirm();
							}
						: onConfirm,
				);
			},
			async clearErrors() {
				await run('confirmed', () => handlers.onClearErrors?.());
			},
			cancel() {
				if (!running) finish('cancelled');
				closePopup();
			},
			subscribeErrors: handlers.subscribeErrors,
		};

		void (deps.show ?? showInTmux)(spec, popupSize(spec, client), actions).then(
			shown => {
				if (!shown) {
					finish('unavailable');
					return;
				}

				popup = shown;
				if (closeRequested) shown.close();
				void shown.closed.then(() => {
					markPopupClosed();
					if (!running) finish('cancelled');
				});
			},
		);
	});
}
