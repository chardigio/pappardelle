import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import {until} from '../../test/helpers/wait.ts';
import {buildDisplayPopupArgs, popupClient} from './terminal.ts';

/**
 * Run the popup's command the way tmux does: through a shell with `-c`, in a
 * session of its own. With stdin not a terminal, `tty` reports "not a tty".
 */
function runPopupCommand(ownerPid: number) {
	const dir = mkdtempSync(path.join(tmpdir(), 'popup-terminal-test-'));
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const readyPath = path.join(dir, 'ready');
	const args = buildDisplayPopupArgs({
		readyPath,
		size: {width: 10, height: 5},
		ownerPid,
	});
	const shell = spawn('/bin/sh', ['-c', args.at(-1)!], {
		detached: true,
		stdio: 'ignore',
	});
	const exited = once(shell, 'exit');
	return {shell, exited, readyPath};
}

function isRunning(shell: ChildProcess) {
	return shell.exitCode === null && shell.signalCode === null;
}

test('the popup shell reports the pid tmux started and waits while the TUI lives', async () => {
	const {shell, exited, readyPath} = runPopupCommand(process.pid);
	teardown(() => {
		if (isRunning(shell)) process.kill(-shell.pid!, 'SIGKILL');
	});

	await until(() => existsSync(readyPath));
	expect(readFileSync(readyPath, 'utf8').trim()).toBe(`${shell.pid} not a tty`);
	await delay(200);
	expect(isRunning(shell)).toBe(true);

	// Closing the popup kills the shell's process group, sleep included.
	process.kill(-shell.pid!, 'SIGTERM');
	await exited;
	expect(isRunning(shell)).toBe(false);
});

test('the popup shell exits once the TUI is gone', async () => {
	const owner = spawn('/bin/sh', ['-c', 'exit 0']);
	await once(owner, 'exit');
	const {exited, readyPath} = runPopupCommand(owner.pid!);

	await exited;
	expect(existsSync(readyPath)).toBe(true);
});

test('a popup is left to tmux unless tmux would pick the control-mode client', () => {
	const fallback = {cols: 20, rows: 10};
	const clients = [
		'0\t1794332400\t/dev/pts/3\t120\t40',
		'0\t1794332491\t/dev/pts/31\t160\t52',
		'1\t1794332492\t\t\t',
		'',
	];
	expect(
		popupClient(['0\t120\t40', ...clients].join('\n'), fallback),
	).toStrictEqual({
		args: [],
		size: {cols: 120, rows: 40},
	});
	expect(popupClient(['1\t\t', ...clients].join('\n'), fallback)).toStrictEqual(
		{
			args: ['-c', '/dev/pts/31'],
			size: {cols: 160, rows: 52},
		},
	);
	expect(popupClient('1\t\t\n1\t1794332492\t\t\t\n', fallback)).toStrictEqual({
		args: [],
		size: fallback,
	});
});
