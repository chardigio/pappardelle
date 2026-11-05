import {execFile} from 'node:child_process';
import process from 'node:process';
import {promisify} from 'node:util';
import type {CliRenderer, PasteEvent} from '@opentui/core';

const run = promisify(execFile);

/** Window option naming the pane the pointer last moved over, and when. */
export const POINTER_OPTION = '@pappardelle_pointer';

const DROP_BUFFER = 'pappardelle-drop';
const RECORD_INTERVAL_MS = 250;
// The pointer report and the drop arrive about 1ms apart but reach different
// panes, so the pane holding the drop waits for the other pane's record.
const POINTER_SETTLE_MS = 150;
const POINTER_FRESH_MS = 2000;

/* eslint-disable no-bitwise, no-control-regex */
const SGR_MOUSE = /\u001B\[<(\d+);\d+;\d+[Mm]/g;
const MODIFIER_BITS = 4 | 8 | 16;
const MOTION_WITHOUT_BUTTON = 32 | 3;

/** Whether input holds a pointer move with no button held. */
export function hasPointerMotion(input: string): boolean {
	for (const match of input.matchAll(SGR_MOUSE)) {
		if ((Number(match[1]) & ~MODIFIER_BITS) === MOTION_WITHOUT_BUTTON)
			return true;
	}

	return false;
}
/* eslint-enable no-bitwise, no-control-regex */

export function parsePointerRecord(
	value: string,
): {paneId: string; at: number} | undefined {
	const [paneId, at] = value.split(' ');
	if (!paneId?.startsWith('%') || !at || Number.isNaN(Number(at)))
		return undefined;
	return {paneId, at: Number(at)};
}

/**
 * Ghostty drops a file as a bracketed paste into whichever tmux pane is
 * active, and reports the pointer only as the drag enters the window and
 * right before the drop; tmux passes those reports to the pane under the
 * pointer and can't bind them. So each pane in the layout records itself when
 * the pointer moves over it, focusing itself while the terminal is in the
 * background (the drag), and a pane handed a drop while unfocused passes it on
 * to the pane the pointer was over.
 */
export function routeDrops(
	renderer: CliRenderer,
	{
		socket,
		paneId,
		isFocused: initiallyFocused,
	}: {socket: string; paneId: string; isFocused: boolean},
): void {
	const tmux = async (args: string[]) =>
		run('tmux', ['-S', socket, ...args], {encoding: 'utf8'});

	let isFocused = initiallyFocused;
	renderer.on('focus', () => {
		isFocused = true;
	});
	renderer.on('blur', () => {
		isFocused = false;
	});

	let lastRecordedAt = 0;
	process.stdin.on('data', (chunk: Uint8Array | string) => {
		const now = Date.now();
		if (now - lastRecordedAt < RECORD_INTERVAL_MS) return;
		if (!hasPointerMotion(chunk.toString())) return;
		lastRecordedAt = now;
		tmux([
			'set-option',
			'-w',
			'-t',
			paneId,
			POINTER_OPTION,
			`${paneId} ${now}`,
			';',
			'if-shell',
			'-F',
			'-t',
			paneId,
			'#{m:*focused*,#{client_flags}}',
			'',
			`select-pane -t ${paneId}`,
		]).catch(() => undefined);
	});

	let redelivering = false;
	renderer.keyInput.on('paste', (event: PasteEvent) => {
		if (redelivering || isFocused) return;
		event.preventDefault();
		const {bytes, metadata} = event;
		void (async () => {
			await new Promise(resolve => {
				setTimeout(resolve, POINTER_SETTLE_MS);
			});
			const target = await pointerPane();
			if (target && target !== paneId) {
				await tmux([
					'set-buffer',
					'-b',
					DROP_BUFFER,
					'--',
					new TextDecoder().decode(bytes),
					';',
					'paste-buffer',
					'-p',
					'-d',
					'-b',
					DROP_BUFFER,
					'-t',
					target,
					';',
					'select-pane',
					'-t',
					target,
				]).catch(() => undefined);
				return;
			}

			redelivering = true;
			try {
				renderer.keyInput.processPaste(bytes, metadata);
			} finally {
				redelivering = false;
			}
		})();
	});

	async function pointerPane(): Promise<string | undefined> {
		const result = await tmux([
			'display-message',
			'-p',
			'-t',
			paneId,
			`#{${POINTER_OPTION}}`,
		]).catch(() => undefined);
		const record = parsePointerRecord(result?.stdout.trim() ?? '');
		if (!record || Date.now() - record.at > POINTER_FRESH_MS) return undefined;
		return record.paneId;
	}
}
