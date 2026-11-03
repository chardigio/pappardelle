import {execFile, spawn} from 'node:child_process';
import {
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
	close(): void;
};

export type PopupLaunch = {
	readyPath: string;
	size: PopupSize;
	ownerPid: number;
};

export function buildDisplayPopupArgs({
	readyPath,
	size,
	ownerPid,
}: PopupLaunch): string[] {
	const pending = shellQuote(`${readyPath}.tmp`);
	const script = [
		// The popup's tty starts cooked, so a key typed right behind the one that
		// opened the popup would be echoed over the first frame and Enter would
		// arrive as a line feed, which Ink doesn't read as Return. Raw from the
		// start, the keys wait unchanged for Ink.
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
					execFile('tmux', ['display-popup', '-C']);
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
	const closed = new Promise<void>(resolve => {
		const popup = spawn(
			'tmux',
			buildDisplayPopupArgs({readyPath, size, ownerPid: process.pid}),
			{stdio: 'ignore'},
		);
		popup.on('error', error => {
			log.warn('display-popup failed', error);
			resolve();
		});
		popup.on('exit', () => {
			resolve();
		});
	});

	try {
		const ready = await waitForReady(dir, readyPath, closed);
		if (!ready) return undefined;
		const [pid, ttyPath = ''] = ready.split(' ');
		const shellPid = Number(pid);
		let input: tty.ReadStream;
		let output: tty.WriteStream;
		try {
			input = new tty.ReadStream(openSync(ttyPath, 'r+'));
			output = new tty.WriteStream(openSync(ttyPath, 'r+'));
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
			close() {
				if (isClosing) return;
				isClosing = true;
				input.destroy();
				output.destroy();
				killPopupShell(shellPid);
			},
		};
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
}
