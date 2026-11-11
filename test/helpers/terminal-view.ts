import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import type React from 'react';
import {flushSync} from '@opentui/react';
import xterm from '@xterm/headless';
import {renderTui} from '../../source/render-tui.ts';

/**
 * Renders into a headless xterm, so tests see what a real terminal shows
 * after it interprets OpenTUI's escape codes.
 */
export async function terminalView(
	node: React.ReactNode,
	{
		columns = 60,
		rows = 12,
		typedAhead = '',
		ready,
	}: {
		columns?: number;
		rows?: number;
		typedAhead?: string;
		ready?: Promise<void>;
	} = {},
) {
	const stdout = Object.assign(new PassThrough(), {
		isTTY: true,
		rows,
		columns,
	});
	const stdin = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode() {},
		ref() {},
		unref() {},
	});
	let output = '';
	stdout.on('data', data => {
		output += data.toString();
	});
	const terminal = new xterm.Terminal({
		cols: columns,
		rows,
		allowProposedApi: true,
	});
	// Input that is waiting when the renderer starts reading.
	if (typedAhead) stdin.write(typedAhead);
	const view = await renderTui(
		node,
		{
			stdout: stdout as unknown as NodeJS.WriteStream,
			stdin: stdin as unknown as NodeJS.ReadStream,
			exitOnCtrlC: false,
			exitSignals: [],
			useMouse: false,
		},
		undefined,
		ready,
	);
	const flush = async () => {
		await delay(30);
		await view.renderer.idle();
		const bytes = output;
		output = '';
		await new Promise<void>(resolve => {
			terminal.write(bytes, resolve);
		});
		return bytes;
	};
	await flush();
	return {
		...view,
		terminal,
		stdin,
		flush,
		async update(next: React.ReactNode) {
			flushSync(() => view.rerender(next));
			return flush();
		},
		line: (row: number) =>
			terminal.buffer.active.getLine(row)?.translateToString(true).trimEnd(),
		async dispose() {
			view.renderer.destroy();
			await view.renderer.closed;
			terminal.dispose();
		},
	};
}
