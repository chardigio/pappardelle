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
import {pathToFileURL} from 'node:url';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import React from 'react';
import {terminalView} from '../test/helpers/terminal-view.ts';
import {LatestTask} from './latest-task.ts';
import {quitOnCtrlC} from './render-tui.ts';
import {useKeyboard, usePaste} from '@opentui/react';

const list = (query: string, rows: string[]) =>
	React.createElement(
		'box',
		{height: '100%', flexDirection: 'column'},
		React.createElement('text', null, 'Workspace list'),
		React.createElement('text', null, '/' + query),
		...rows.map(row => React.createElement('text', {key: row}, row)),
	);

test('updating startup metadata preserves keyboard state and the mounted view', async () => {
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
	teardown(async () => view.dispose());
	view.stdin.write('x');
	await view.flush();
	expect(view.line(0)).toBe('unknown x');
	await view.update(React.createElement(Stateful, {sha: 'abc123'}));
	expect(view.line(0)).toBe('abc123 x');
	expect(mounts).toBe(1);
});

// Each handler reads state from its render, as the rail's handlers do, so a key
// sees what the key before it did only if that key was committed first.
function Counter() {
	const [count, setCount] = React.useState(0);
	useKeyboard(key => {
		if (key.name === 'j') setCount(count + 1);
	});
	return React.createElement('text', null, `count ${count}`);
}

test('keys in one write each act on what the key before did', async () => {
	const view = await terminalView(React.createElement(Counter));
	teardown(async () => view.dispose());
	view.stdin.write('jjj');
	await view.flush();
	expect(view.line(0)).toBe('count 3');
});

test('keys typed while a view starts each act on what the key before did', async () => {
	const view = await terminalView(React.createElement(Counter), {
		typedAhead: 'jjj',
	});
	teardown(async () => view.dispose());
	await view.flush();
	expect(view.line(0)).toBe('count 3');
});

test('a view opened by a key takes the rest of the write', async () => {
	const rail: string[] = [];
	const dialog: string[] = [];
	function Dialog() {
		useKeyboard(key => dialog.push(key.name));
		return React.createElement('text', null, 'dialog');
	}
	function Rail() {
		const [isOpen, setIsOpen] = React.useState(false);
		useKeyboard(key => {
			if (isOpen) return;
			if (key.name === 'n') setIsOpen(true);
			else rail.push(key.name);
		});
		return isOpen
			? React.createElement(Dialog)
			: React.createElement('text', null, 'rail');
	}
	const view = await terminalView(React.createElement(Rail));
	teardown(async () => view.dispose());
	view.stdin.write('nab');
	await view.flush();
	expect(rail).toStrictEqual([]);
	expect(dialog).toStrictEqual(['a', 'b']);
});

test("work a key's commit queues is ahead of the next key's", async () => {
	const queue = new LatestTask();
	const done: string[] = [];
	// As in app.tsx: selecting a row queues its attachment from an effect, and
	// Enter queues focus behind whatever is queued.
	function Rail() {
		const [selected, setSelected] = React.useState(0);
		React.useEffect(() => {
			void queue.run(async () => {
				done.push(`attach ${selected}`);
			});
		}, [selected]);
		useKeyboard(key => {
			if (key.name === 'j') setSelected(selected + 1);
			if (key.name === 'return') {
				void queue.exclusive(async () => {
					done.push(`focus ${selected}`);
				});
			}
		});
		return React.createElement('text', null, `row ${selected}`);
	}
	const view = await terminalView(React.createElement(Rail));
	teardown(async () => view.dispose());
	await queue.idle();
	done.length = 0;
	view.stdin.write('j\r');
	await view.flush();
	await queue.idle();
	expect(done).toStrictEqual(['attach 1', 'focus 1']);
});

test('a paste and the keys after it in one write', async () => {
	function Filter() {
		const [query, setQuery] = React.useState('');
		usePaste(event => {
			setQuery(query + new TextDecoder().decode(event.bytes));
		});
		useKeyboard(key => {
			if (key.name === 'x') setQuery(query + 'x');
		});
		return React.createElement('text', null, `query ${query}`);
	}
	const view = await terminalView(React.createElement(Filter));
	teardown(async () => view.dispose());
	view.stdin.write('\u001B[200~front\u001B[201~x');
	await view.flush();
	expect(view.line(0)).toBe('query frontx');
});

test('filtering and resizing remove stale rows and keep the list at the top', async () => {
	const view = await terminalView(
		list('', ['main', 'TEST-1 Fix flickering', 'OLD-ROW']),
	);
	teardown(async () => view.dispose());
	expect(view.line(4)).toBe('OLD-ROW');
	for (const [width, height] of [
		[100, 24],
		[30, 8],
		[60, 12],
	]) {
		view.terminal.resize(width!, height!);
		view.renderer.resize(width!, height!);
		await view.update(list('main', ['main']));
		expect(view.line(0)).toBe('Workspace list');
		expect(view.line(1)).toBe('/main');
		expect(view.line(2)).toBe('main');
		for (let row = 3; row < height!; row++) expect(view.line(row)).toBe('');
	}
});

test('typing changes only affected cells and identical frames emit no text', async () => {
	const view = await terminalView(list('a', ['main', 'TEST-1 Fix flickering']));
	teardown(async () => view.dispose());
	const update = await view.update(
		list('ab', ['main', 'TEST-1 Fix flickering']),
	);
	expect(view.line(1)).toBe('/ab');
	expect(update.includes('Workspace list')).toBe(false);
	expect(update.includes('TEST-1')).toBe(false);
	expect(update.includes('\x1b[2J')).toBe(false);
	const unchanged = await view.update(
		list('ab', ['main', 'TEST-1 Fix flickering']),
	);
	expect(unchanged.includes('ab')).toBe(false);
	expect(view.line(2)).toBe('main');
});

test('confirmed pane geometry is used before SIGWINCH arrives', async () => {
	const message = 'Dialog ' + '-'.repeat(90) + ' READY';
	const dialog = () =>
		React.createElement('text', {wrapMode: 'none', height: 1}, message);
	const view = await terminalView(dialog());
	teardown(async () => view.dispose());
	expect(view.line(0)?.includes('READY')).toBe(false);
	view.terminal.resize(140, 30);
	view.renderer.resize(140, 30);
	await view.update(dialog());
	expect(view.line(0)).toBe(message);
});

test('a render failure stays visible and Escape restores the terminal', async () => {
	clearRecentErrors();
	const failure = new Error('No profiles defined');
	const originalConsoleError = console.error;
	const consoleErrors: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		consoleErrors.push(args);
	};
	teardown(() => {
		console.error = originalConsoleError;
		clearRecentErrors();
	});
	function Broken(): React.ReactNode {
		throw failure;
	}
	const view = await terminalView(React.createElement(Broken));
	teardown(async () => view.dispose());
	expect(view.line(1)?.includes('Unable to render this view')).toBe(true);
	expect(view.line(2)?.includes('No profiles defined')).toBe(true);
	const entry = getRecentErrors().find(error => error.component === 'tui');
	expect(entry?.message.startsWith(failure.stack!)).toBe(true);
	expect(entry?.message.includes('at Broken')).toBe(true);
	expect(entry?.error).toBe(failure.message);
	const logfile = path.join(
		getLogDir(),
		`pappardelle-${entry!.timestamp.split('T')[0]}.log`,
	);
	expect(readFileSync(logfile, 'utf8').includes(failure.stack!)).toBe(true);
	// Reaching console.error at all means OpenTUI left the log redirect in place.
	expect(consoleErrors.length > 0).toBe(true);
	expect(consoleErrors.every(args => isCaughtBoundaryReport(args))).toBe(true);
	view.stdin.write('\x1b');
	await view.renderer.closed;
	const bytes = await view.flush();
	expect(bytes.includes('\x1b[?1049l')).toBe(true);
});

test('Ctrl+C runs the quit handler instead of only destroying the renderer', async () => {
	const {createTestRenderer} = await import('@opentui/core/testing');
	const {renderer, mockInput} = await createTestRenderer({
		exitOnCtrlC: false,
	});
	teardown(() => {
		renderer.destroy();
	});
	let quits = 0;
	quitOnCtrlC(renderer, () => {
		quits++;
	});

	mockInput.pressKey('c');
	expect(quits).toBe(0);
	mockInput.pressCtrlC();
	expect(quits).toBe(1);
});

test('the first of SIGINT, SIGTERM or SIGHUP quits once, and a later one cannot end teardown early', () => {
	const loggerUrl = pathToFileURL(path.resolve('source/logger.ts')).href;
	const moduleUrl = pathToFileURL(path.resolve('source/render-tui.ts')).href;
	const home = mkdtempSync(path.join(tmpdir(), 'pappardelle-home-'));
	teardown(() => {
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
	expect(child.stdout).toBe('quit\ntorn down\n');
	expect(child.status).toBe(0);
});
