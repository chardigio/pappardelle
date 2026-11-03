import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {buildDisplayPopupArgs} from './terminal.ts';

/**
 * Run the popup's command the way tmux does: through a shell with `-c`, in a
 * session of its own. With stdin not a terminal, `tty` reports "not a tty".
 */
function runPopupCommand(
	t: {teardown: (fn: () => void) => void},
	ownerPid: number,
) {
	const dir = mkdtempSync(path.join(tmpdir(), 'popup-terminal-test-'));
	t.teardown(() => {
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

async function until(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('condition never held');
		await delay(10);
	}
}

function isRunning(shell: ChildProcess) {
	return shell.exitCode === null && shell.signalCode === null;
}

test('the popup shell reports the pid tmux started and waits while the TUI lives', async t => {
	const {shell, exited, readyPath} = runPopupCommand(t, process.pid);
	t.teardown(() => {
		if (isRunning(shell)) process.kill(-shell.pid!, 'SIGKILL');
	});

	await until(() => existsSync(readyPath));
	t.is(readFileSync(readyPath, 'utf8').trim(), `${shell.pid} not a tty`);
	await delay(200);
	t.true(isRunning(shell));

	// Closing the popup kills the shell's process group, sleep included.
	process.kill(-shell.pid!, 'SIGTERM');
	await exited;
	t.false(isRunning(shell));
});

test('the popup shell exits once the TUI is gone', async t => {
	const owner = spawn('/bin/sh', ['-c', 'exit 0']);
	await once(owner, 'exit');
	const {exited, readyPath} = runPopupCommand(t, owner.pid!);

	await exited;
	t.true(existsSync(readyPath));
});
