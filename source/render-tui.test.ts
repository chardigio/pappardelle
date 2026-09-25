import {PassThrough} from 'node:stream';
import type {Buffer} from 'node:buffer';
import test from 'ava';
import React from 'react';
import {Box, Text} from 'ink';
import xterm from '@xterm/headless';
import {renderTui} from './render-tui.ts';

function terminalOutput() {
	const stdout = Object.assign(new PassThrough(), {
		isTTY: true,
		rows: 12,
		columns: 60,
	});
	let output = '';
	stdout.on('data', (data: Buffer) => {
		output += data.toString();
	});
	return {
		stdout,
		takeOutput() {
			const frame = output;
			output = '';
			return frame;
		},
	};
}

const list = (height: number, query: string, rows: string[]) =>
	React.createElement(
		Box,
		{height, flexDirection: 'column'},
		React.createElement(Text, null, 'Workspace list'),
		React.createElement(Text, null, '/' + query),
		...rows.map(row => React.createElement(Text, {key: row}, row)),
	);

test('typing updates only the query line and skips identical full-height frames', async t => {
	const output = terminalOutput();
	const view = renderTui(list(12, 'a', ['main', 'TEST-1 Fix flickering']), {
		stdout: output.stdout as unknown as NodeJS.WriteStream,
		patchConsole: false,
		interactive: true,
	});
	t.teardown(() => view.unmount());
	await view.waitUntilRenderFlush();
	output.takeOutput();

	view.rerender(list(12, 'ab', ['main', 'TEST-1 Fix flickering']));
	await view.waitUntilRenderFlush();
	const update = output.takeOutput();
	t.true(update.includes('/ab'));
	t.false(update.includes('Workspace list'));
	t.false(update.includes('TEST-1'));
	t.false(update.includes('\x1b[2J'));
	t.true(update.startsWith('\x1b[?2026h'));
	t.true(update.endsWith('\x1b[?2026l'));

	view.rerender(list(12, 'ab', ['main', 'TEST-1 Fix flickering']));
	await view.waitUntilRenderFlush();
	t.is(output.takeOutput(), '');
});

test('filtering and resizing remove stale rows and keep the list at the top', async t => {
	const output = terminalOutput();
	const terminal = new xterm.Terminal({
		cols: 60,
		rows: 12,
		allowProposedApi: true,
	});
	terminal.write('\x1b[?1049h');
	t.teardown(() => terminal.dispose());
	const view = renderTui(
		list(12, '', ['main', 'TEST-1 Fix flickering', 'OLD-ROW']),
		{
			stdout: output.stdout as unknown as NodeJS.WriteStream,
			patchConsole: false,
			interactive: true,
		},
	);
	t.teardown(() => view.unmount());
	const flush = async () => {
		await view.waitUntilRenderFlush();
		await new Promise<void>(resolve => {
			// A real PTY's ONLCR mode supplies the carriage returns.
			terminal.write(output.takeOutput().replaceAll('\n', '\r\n'), resolve);
		});
	};
	await flush();
	t.is(terminal.buffer.active.getLine(4)?.translateToString(true), 'OLD-ROW');

	for (const [columns, height] of [
		[100, 24],
		[30, 8],
		[60, 12],
	]) {
		terminal.resize(columns!, height!);
		output.stdout.columns = columns!;
		output.stdout.rows = height!;
		output.stdout.emit('resize');
		view.rerender(list(height!, 'main', ['main']));
		await flush();
		t.is(
			terminal.buffer.active.getLine(0)?.translateToString(true),
			'Workspace list',
		);
		t.is(terminal.buffer.active.getLine(1)?.translateToString(true), '/main');
		t.is(terminal.buffer.active.getLine(2)?.translateToString(true), 'main');
		for (let row = 3; row < height!; row++) {
			t.is(terminal.buffer.active.getLine(row)?.translateToString(true), '');
		}
	}
});
