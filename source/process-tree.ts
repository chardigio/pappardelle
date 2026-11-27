// What the resume monitor reads about processes, the same on Linux and
// macOS: `ps` for the tree and `/proc` or `lsof` for a working directory.

import {spawnSync} from 'node:child_process';
import {readlinkSync} from 'node:fs';

export type ProcessInfo = {
	pid: number;
	ppid: number;
	uid: number;
	/** When it started, as `ps` prints it. Tells a reused pid from its owner. */
	started: string;
};

export interface ProcessInspector {
	processes(): Map<number, ProcessInfo>;
	/** A process's working directory, or undefined when the OS won't say. */
	cwd(pid: number): string | undefined;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;

export function parsePsListing(stdout: string): Map<number, ProcessInfo> {
	const processes = new Map<number, ProcessInfo>();
	for (const line of stdout.split('\n')) {
		const match = PS_LINE.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		processes.set(pid, {
			pid,
			ppid: Number(match[2]),
			uid: Number(match[3]),
			started: match[4]!,
		});
	}
	return processes;
}

function lsofCwd(pid: number): string | undefined {
	const result = spawnSync(
		'lsof',
		['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
		{
			encoding: 'utf8',
		},
	);
	if (result.status !== 0) return undefined;
	const name = result.stdout.split('\n').find(line => line.startsWith('n'));
	return name?.slice(1) || undefined;
}

export const systemProcesses: ProcessInspector = {
	processes() {
		const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,uid=,lstart='], {
			encoding: 'utf8',
			env: {...process.env, LC_ALL: 'C'},
		});
		return result.status === 0 ? parsePsListing(result.stdout) : new Map();
	},
	cwd(pid) {
		if (process.platform === 'linux') {
			try {
				return readlinkSync(`/proc/${pid}/cwd`);
			} catch {
				return undefined;
			}
		}
		return lsofCwd(pid);
	},
};

/**
 * How many parents up from `pid` the pane's first process is: 0 for the
 * first process itself, undefined when `pid` doesn't descend from it.
 */
export function depthBelow(
	processes: Map<number, ProcessInfo>,
	pid: number,
	root: number,
): number | undefined {
	let depth = 0;
	for (let current = processes.get(pid); current; depth++) {
		if (current.pid === root) return depth;
		if (current.ppid === current.pid || depth > processes.size)
			return undefined;
		current = processes.get(current.ppid);
	}
	return undefined;
}
