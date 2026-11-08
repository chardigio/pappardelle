import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	openPopupTerminal,
	type PopupTerminal,
} from '../source/popup/terminal.ts';

// Popups only show on an attached client, so this attaches a real one in a
// pty to a throwaway server. A popup the rail is done with must close and
// release its pty; a stuck one keeps every key the user types.
const root = mkdtempSync(path.join(tmpdir(), 'pappa-popup-close-'));
const socket = path.join(root, 'tmux.sock');
const tmux = (args: string[]) =>
	execFileSync('tmux', ['-S', socket, ...args], {encoding: 'utf8'});
const {TMUX_PANE: _pane, ...cleanEnv} = process.env;
delete cleanEnv.TMUX;

async function settles(promise: Promise<void>, ms: number) {
	return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

function popupTtyPath(terminal: PopupTerminal) {
	return readlinkSync(`/proc/self/fd/${terminal.input.fd}`);
}

function fdsOn(ttyPath: string) {
	return readdirSync('/proc/self/fd').filter(fd => {
		try {
			return readlinkSync(`/proc/self/fd/${fd}`).startsWith(ttyPath);
		} catch {
			return false;
		}
	});
}

// What the OpenTUI renderer leaves behind on the popup's input: a read that
// was started, then paused when it tore down.
async function readLikeRenderer(terminal: PopupTerminal) {
	const onData = () => {};
	terminal.input.setRawMode(true);
	terminal.input.on('data', onData);
	await delay(200);
	terminal.input.setRawMode(false);
	terminal.input.removeListener('data', onData);
	terminal.input.pause();
}

let client: ReturnType<typeof Bun.spawn> | undefined;
try {
	execFileSync(
		'tmux',
		[
			'-S',
			socket,
			'-f',
			'/dev/null',
			'new-session',
			'-d',
			'-s',
			'host',
			'-x',
			'120',
			'-y',
			'40',
			'sleep 600',
		],
		{env: cleanEnv},
	);
	client = Bun.spawn(['tmux', '-S', socket, 'attach', '-t', 'host'], {
		env: cleanEnv,
		terminal: {cols: 120, rows: 40, data() {}},
	});
	const end = Date.now() + 5000;
	while (!tmux(['list-clients', '-F', '#{client_name}']).trim()) {
		assert.ok(Date.now() < end, 'tmux client never attached');
		await delay(50);
	}

	process.env['TMUX'] = `${socket},0,0`;
	delete process.env['TMUX_PANE'];
	const size = {width: 40, height: 10};

	const first = await openPopupTerminal(size);
	assert.ok(first, 'popup did not open');
	const ttyPath = process.platform === 'linux' ? popupTtyPath(first) : '';
	await readLikeRenderer(first);
	first.close();
	assert.ok(
		await settles(first.closed, 3000),
		'popup stayed open after close()',
	);
	console.log('PASS a closed popup goes away');
	if (ttyPath) {
		await delay(200);
		assert.deepEqual(fdsOn(ttyPath), [], `fds left open on ${ttyPath}`);
		console.log('PASS the rail keeps no fd on the closed popup pty');
	}

	const second = await openPopupTerminal(size);
	assert.ok(second, 'popup did not reopen right after a close');
	assert.equal(
		await settles(second.closed, 1000),
		false,
		'a popup opened right after a close was closed with it',
	);
	second.close();
	assert.ok(await settles(second.closed, 3000), 'second popup stayed open');
	console.log('PASS a popup opened right after a close stays open');
} finally {
	try {
		tmux(['kill-server']);
	} catch {}

	client?.kill();
	rmSync(root, {recursive: true, force: true});
}
