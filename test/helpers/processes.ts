import {execFileSync} from 'node:child_process';

/** The pids of the running processes whose command line has every one of `texts`. */
export function processesNaming(...texts: string[]): number[] {
	// One -o per column: a header given with `=` runs to the end of its
	// argument on some systems.
	return execFileSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'args='], {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	})
		.split('\n')
		.filter(line => texts.every(text => line.includes(text)))
		.map(line => Number.parseInt(line, 10))
		.filter(pid => pid !== process.pid);
}

/** Kill what `processesNaming` finds. For a teardown. */
export function killProcessesNaming(...texts: string[]): void {
	for (const pid of processesNaming(...texts)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
}
