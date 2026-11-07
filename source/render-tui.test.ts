import {readFileSync} from 'node:fs';
import path from 'node:path';
import {clearRecentErrors, getRecentErrors, getLogDir} from './logger.ts';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import React from 'react';
import {flushSync} from '@opentui/react';
import xterm from '@xterm/headless';
import {renderTui} from './render-tui.ts';

const list = (query: string, rows: string[]) =>
	React.createElement(
		'box',
		{height: '100%', flexDirection: 'column'},
		React.createElement('text', null, 'Workspace list'),
		React.createElement('text', null, '/' + query),
		...rows.map(row => React.createElement('text', {key: row}, row)),
	);

async function terminalView(node: React.ReactNode) {
	const stdout = Object.assign(new PassThrough(), {
		isTTY: true,
		rows: 12,
		columns: 60,
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
		cols: 60,
		rows: 12,
		allowProposedApi: true,
	});
	const view = await renderTui(node, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		exitOnCtrlC: false,
		exitSignals: [],
		useMouse: false,
	});
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
			flushSync(() => view.root.render(next));
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

test.serial(
	'filtering and resizing remove stale rows and keep the list at the top',
	async t => {
		const view = await terminalView(
			list('', ['main', 'TEST-1 Fix flickering', 'OLD-ROW']),
		);
		t.teardown(async () => view.dispose());
		t.is(view.line(4), 'OLD-ROW');
		for (const [width, height] of [
			[100, 24],
			[30, 8],
			[60, 12],
		]) {
			view.terminal.resize(width!, height!);
			view.renderer.resize(width!, height!);
			await view.update(list('main', ['main']));
			t.is(view.line(0), 'Workspace list');
			t.is(view.line(1), '/main');
			t.is(view.line(2), 'main');
			for (let row = 3; row < height!; row++) t.is(view.line(row), '');
		}
	},
);

test.serial(
	'typing changes only affected cells and identical frames emit no text',
	async t => {
		const view = await terminalView(
			list('a', ['main', 'TEST-1 Fix flickering']),
		);
		t.teardown(async () => view.dispose());
		const update = await view.update(
			list('ab', ['main', 'TEST-1 Fix flickering']),
		);
		t.is(view.line(1), '/ab');
		t.false(update.includes('Workspace list'));
		t.false(update.includes('TEST-1'));
		t.false(update.includes('\x1b[2J'));
		const unchanged = await view.update(
			list('ab', ['main', 'TEST-1 Fix flickering']),
		);
		t.false(unchanged.includes('ab'));
		t.is(view.line(2), 'main');
	},
);

test.serial(
	'confirmed pane geometry is used before SIGWINCH arrives',
	async t => {
		const message = 'Dialog ' + '-'.repeat(90) + ' READY';
		const dialog = () =>
			React.createElement('text', {wrapMode: 'none', height: 1}, message);
		const view = await terminalView(dialog());
		t.teardown(async () => view.dispose());
		t.false(view.line(0)?.includes('READY'));
		view.terminal.resize(140, 30);
		view.renderer.resize(140, 30);
		await view.update(dialog());
		t.is(view.line(0), message);
	},
);

test.serial(
	'a render failure stays visible and Escape restores the terminal',
	async t => {
		clearRecentErrors();
		const failure = new Error('No profiles defined');
		const originalConsoleError = console.error;
		const consoleErrors: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			consoleErrors.push(args);
		};
		t.teardown(() => {
			console.error = originalConsoleError;
			clearRecentErrors();
		});
		function Broken(): React.ReactNode {
			throw failure;
		}
		const view = await terminalView(React.createElement(Broken));
		t.teardown(async () => view.dispose());
		t.true(view.line(1)?.includes('Unable to render this view'));
		t.true(view.line(2)?.includes('No profiles defined'));
		const entry = getRecentErrors().find(error => error.component === 'tui');
		t.is(entry?.message, failure.stack);
		t.is(entry?.error, failure.message);
		const logfile = path.join(
			getLogDir(),
			`pappardelle-${entry!.timestamp.split('T')[0]}.log`,
		);
		t.true(readFileSync(logfile, 'utf8').includes(failure.stack!));
		t.deepEqual(consoleErrors, []);
		view.stdin.write('\x1b');
		await view.renderer.closed;
		const bytes = await view.flush();
		t.true(bytes.includes('\x1b[?1049l'));
	},
);
