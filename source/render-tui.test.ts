import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	clearRecentErrors,
	getRecentErrors,
	getLogDir,
	isCaughtBoundaryReport,
} from './logger.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import test from 'ava';
import React from 'react';
import {terminalView} from '../test/helpers/terminal-view.ts';
import {quitOnCtrlC, quitOnSignals} from './render-tui.ts';
import {useKeyboard} from '@opentui/react';

const list = (query: string, rows: string[]) =>
	React.createElement(
		'box',
		{height: '100%', flexDirection: 'column'},
		React.createElement('text', null, 'Workspace list'),
		React.createElement('text', null, '/' + query),
		...rows.map(row => React.createElement('text', {key: row}, row)),
	);

test.serial(
	'updating startup metadata preserves keyboard state and the mounted view',
	async t => {
		let mounts = 0;
		function Stateful({sha}: {sha: string}) {
			const [input, setInput] = React.useState('');
			React.useEffect(() => {
				mounts++;
			}, []);
			useKeyboard(key => {
				if (key.name === 'x') setInput(value => value + 'x');
			});
			return React.createElement('text', null, `${sha} ${input}`);
		}
		const view = await terminalView(
			React.createElement(Stateful, {sha: 'unknown'}),
		);
		t.teardown(async () => view.dispose());
		view.stdin.write('x');
		await view.flush();
		t.is(view.line(0), 'unknown x');
		await view.update(React.createElement(Stateful, {sha: 'abc123'}));
		t.is(view.line(0), 'abc123 x');
		t.is(mounts, 1);
	},
);

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
		t.true(entry?.message.startsWith(failure.stack!));
		t.true(entry?.message.includes('at Broken'));
		t.is(entry?.error, failure.message);
		const logfile = path.join(
			getLogDir(),
			`pappardelle-${entry!.timestamp.split('T')[0]}.log`,
		);
		t.true(readFileSync(logfile, 'utf8').includes(failure.stack!));
		// Reaching console.error at all means OpenTUI left the log redirect in place.
		t.true(consoleErrors.length > 0);
		t.true(consoleErrors.every(args => isCaughtBoundaryReport(args)));
		view.stdin.write('\x1b');
		await view.renderer.closed;
		const bytes = await view.flush();
		t.true(bytes.includes('\x1b[?1049l'));
	},
);

test.serial(
	'Ctrl+C runs the quit handler instead of only destroying the renderer',
	async t => {
		const {createTestRenderer} = await import('@opentui/core/testing');
		const {renderer, mockInput} = await createTestRenderer({
			exitOnCtrlC: false,
		});
		t.teardown(() => {
			renderer.destroy();
		});
		let quits = 0;
		quitOnCtrlC(renderer, () => {
			quits++;
		});

		mockInput.pressKey('c');
		t.is(quits, 0);
		mockInput.pressCtrlC();
		t.is(quits, 1);
	},
);

test.serial(
	'the first of SIGINT, SIGTERM or SIGHUP quits once, and a later one cannot end teardown early',
	t => {
		const loggerUrl = pathToFileURL(path.resolve('source/logger.ts')).href;
		const moduleUrl = pathToFileURL(path.resolve('source/render-tui.ts')).href;
		const home = mkdtempSync(path.join(tmpdir(), 'pappardelle-home-'));
		t.teardown(() => {
			rmSync(home, {recursive: true, force: true});
		});
		const child = spawnSync(
			process.execPath,
			[
				'-e',
				`const {writeSync} = await import('node:fs');
await import(${JSON.stringify(loggerUrl)});
const {quitOnSignals} = await import(${JSON.stringify(moduleUrl)});
quitOnSignals(() => {
	writeSync(1, 'quit\\n');
	process.kill(process.pid, 'SIGTERM');
	setTimeout(() => {
		writeSync(1, 'torn down\\n');
		process.exit(0);
	}, 50);
});
setInterval(() => {}, 1000);
process.kill(process.pid, 'SIGHUP');`,
			],
			{encoding: 'utf8', env: {...process.env, HOME: home}},
		);
		t.is(child.stdout, 'quit\ntorn down\n');
		t.is(child.status, 0);
	},
);
