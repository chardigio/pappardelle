import {execFile, execFileSync, spawn} from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	watch,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import tty from 'node:tty';
import {createLogger} from '../logger.ts';
import {shellQuote} from '../shell-quote.ts';
import type {PopupSize} from './size.ts';

const log = createLogger('popup');

/** A tmux popup's terminal, drawn into by the TUI process itself. */
export type PopupTerminal = {
	input: tty.ReadStream;
	output: tty.WriteStream;
	/** Resolves once the popup has closed, whoever closed it. */
	closed: Promise<void>;
	/**
	 * Take the popup off the client now. The renderer drawing into it needs
	 * about 20 ms to shut down, and `close` has to wait for that.
	 */
	dismiss(): void;
	close(): void;
};

export type PopupLaunch = {
	readyPath: string;
	size: PopupSize;
	ownerPid: number;
	/** `-c` and the client to show the popup on, or nothing for tmux's choice. */
	client?: string[];
};

/**
 * The terminal the user was last at, from `list-clients` lines of control
 * mode, activity time and tty. Left to itself tmux shows a popup on the
 * session's most recently active client, and the TUI's control-mode client,
 * which cannot show one, counts as active each time it attaches.
 */
export function newestTerminalClient(listing: string): string | undefined {
	let newest: {activity: number; tty: string} | undefined;
	for (const line of listing.split('\n')) {
		const [control, activity, tty] = line.split('\t');
		if (control !== '0' || !tty) continue;
		if (!newest || Number(activity) >= newest.activity)
			newest = {activity: Number(activity), tty};
	}

	return newest?.tty;
}

/** `-c <client>` for a popup command, empty when the client is not known. */
export async function userClientArgs(): Promise<string[]> {
	const pane = process.env['TMUX_PANE'];
	if (!pane) return [];
	return new Promise(resolve => {
		execFile(
			'tmux',
			[
				'list-clients',
				'-t',
				pane,
				'-F',
				'#{client_control_mode}\t#{client_activity}\t#{client_tty}',
			],
			{encoding: 'utf8', timeout: 2000},
			(error, stdout) => {
				const client = error ? undefined : newestTerminalClient(stdout);
				resolve(client ? ['-c', client] : []);
			},
		);
	});
}

export function buildDisplayPopupArgs({
	readyPath,
	size,
	ownerPid,
	client = [],
}: PopupLaunch): string[] {
	const pending = shellQuote(`${readyPath}.tmp`);
	const script = [
		// The popup's tty starts cooked, so a key typed right behind the one that
		// opened the popup would be echoed over the first frame and Enter would
		// arrive as a line feed, which OpenTUI reports as `linefeed`, not Return.
		// Raw from the start, the keys wait unchanged for the renderer.
		'stty -icanon -echo -icrnl min 1 time 0 2>/dev/null',
		// Written whole and then renamed, so the TUI never reads half a line.
		`echo "$$ $(tty)" > ${pending} && mv ${pending} ${shellQuote(readyPath)}`,
		// The TUI kills this shell to close the popup. If the TUI dies first,
		// nothing would, and the popup would hold the client's keys forever.
		`while kill -0 ${ownerPid} 2>/dev/null; do sleep 1; done`,
	].join('; ');
	// tmux runs the command with the user's default-shell, which may be fish or
	// csh. exec keeps the popup's process group led by the shell the TUI kills.
	const command = `exec /bin/sh -c ${shellQuote(script)}`;
	return [
		'display-popup',
		...client,
		'-B',
		'-E',
		'-w',
		String(size.width),
		'-h',
		String(size.height),
		command,
	];
}

// A popup that tmux shows but whose shell never reports in would otherwise
// hold the client's keys with nothing drawn in it.
const READY_TIMEOUT_MS = 5000;

async function waitForReady(
	dir: string,
	readyPath: string,
	popupExited: Promise<void>,
	client: string[],
): Promise<string | undefined> {
	const watcher = watch(dir);
	const timeout = new AbortController();
	try {
		const reported = new Promise<string>(resolve => {
			const check = () => {
				if (existsSync(readyPath)) {
					resolve(readFileSync(readyPath, 'utf8').trim());
				}
			};

			watcher.on('change', check);
			check();
		});
		return await Promise.race([
			reported,
			popupExited.then(() => undefined),
			delay(READY_TIMEOUT_MS, undefined, {signal: timeout.signal})
				.then(() => {
					execFile('tmux', ['display-popup', ...client, '-C']);
					return undefined;
				})
				// Aborted once the race is decided.
				.catch(() => undefined),
		]);
	} finally {
		timeout.abort();
		watcher.close();
	}
}

function closePopupOnClient(client: string[]) {
	try {
		execFileSync('tmux', ['display-popup', ...client, '-C'], {
			stdio: 'ignore',
			timeout: 2000,
		});
	} catch (error) {
		log.warn(
			'display-popup -C failed',
			error instanceof Error ? error : undefined,
		);
	}
}

function killPopupShell(shellPid: number) {
	try {
		// The popup shell leads its own process group, which takes a pending
		// `sleep` down with it.
		process.kill(-shellPid, 'SIGTERM');
	} catch {}
}

/**
 * Open a tmux popup over the current client and hand back its terminal, or
 * undefined when the popup could not be shown. The popup only runs a shell
 * that reports its tty and waits, so nothing has to start up before the TUI
 * can draw into it.
 */
export async function openPopupTerminal(
	size: PopupSize,
): Promise<PopupTerminal | undefined> {
	const dir = mkdtempSync(path.join(tmpdir(), 'pappardelle-popup-'));
	const readyPath = path.join(dir, 'ready');
	let isPopupOpen = true;
	const client = await userClientArgs();
	const closed = new Promise<void>(resolve => {
		const popup = spawn(
			'tmux',
			buildDisplayPopupArgs({readyPath, size, ownerPid: process.pid, client}),
			{stdio: 'ignore'},
		);
		popup.on('error', error => {
			log.warn('display-popup failed', error);
			isPopupOpen = false;
			resolve();
		});
		popup.on('exit', () => {
			isPopupOpen = false;
			resolve();
		});
	});

	try {
		const ready = await waitForReady(dir, readyPath, closed, client);
		if (!ready) return undefined;
		const [pid, ttyPath = ''] = ready.split(' ');
		const shellPid = Number(pid);
		let input: tty.ReadStream;
		let output: tty.WriteStream;
		let outputFd: number;
		try {
			input = new tty.ReadStream(openSync(ttyPath, 'r+'));
			outputFd = openSync(ttyPath, 'r+');
			output = new tty.WriteStream(outputFd);
		} catch (error) {
			log.warn(
				'Could not open the popup terminal',
				error instanceof Error ? error : undefined,
			);
			killPopupShell(shellPid);
			return undefined;
		}

		// Writes can still be in flight when the popup closes under them.
		input.on('error', () => {});
		output.on('error', () => {});
		let isClosing = false;
		return {
			input,
			output,
			closed,
			dismiss() {
				if (isPopupOpen)
					execFile('tmux', ['display-popup', ...client, '-C'], () => {});
			},
			close() {
				if (isClosing) return;
				isClosing = true;
				input.destroy();
				output.destroy();
				// Bun's tty.WriteStream writes through a dup of the fd and destroy()
				// closes only the dup. Left open, the popup's pty never sees EOF,
				// so tmux keeps the blank popup up and it swallows the client's keys.
				closeSync(outputFd);
				killPopupShell(shellPid);
				// The input fd stays open too while Bun has a read pending on it,
				// and only a hangup ends that read, so tmux has to close the popup.
				if (isPopupOpen) closePopupOnClient(client);
			},
		};
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
}
