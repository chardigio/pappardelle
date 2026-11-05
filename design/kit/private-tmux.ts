import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

/**
 * A tmux server on its own socket in a temp dir, so fidelity and bench runs
 * never touch the user's server.
 */
export type PrivateTmux = {
	dir: string;
	run(...args: string[]): string;
	/** Kills the server, and with it whatever its panes run, then the dir. */
	close(): void;
};

export function openPrivateTmux(prefix: string): PrivateTmux {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	const socket = path.join(dir, 's');
	return {
		dir,
		run: (...args) =>
			execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], {
				encoding: 'utf8',
			}),
		close() {
			// A pane's process group is its pid. Killing the server only hangs up
			// on it, and OpenTUI answers SIGHUP by restoring the terminal while
			// timers keep running: an interrupted bench run would go on to write
			// its numbers after bench.ts has put the previous file back.
			const panes = spawnSync(
				'tmux',
				['-S', socket, 'list-panes', '-a', '-F', '#{pane_pid}'],
				{encoding: 'utf8'},
			).stdout;
			for (const pid of panes.split('\n').filter(Boolean)) {
				try {
					process.kill(-Number(pid), 'SIGKILL');
				} catch {}
			}

			// The server exits by itself when its last session ends, and then
			// kill-server only complains that nothing is running.
			spawnSync('tmux', ['-S', socket, 'kill-server'], {stdio: 'ignore'});
			rmSync(dir, {recursive: true, force: true});
		},
	};
}

/**
 * Returns `cleanup` wrapped to run once, and runs it on Ctrl-C or SIGTERM as
 * well, which would otherwise exit without running any `finally`.
 */
export function cleanupOnExit(cleanup: () => void): () => void {
	let isDone = false;
	const once = () => {
		if (isDone) return;
		isDone = true;
		cleanup();
	};

	for (const [signal, code] of [
		['SIGINT', 130],
		['SIGTERM', 143],
	] as const)
		process.on(signal, () => {
			once();
			process.exit(code);
		});
	return once;
}
