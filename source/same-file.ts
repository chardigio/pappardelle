import {statSync} from 'node:fs';

/**
 * Identity by device and inode rather than realpath: Bun's realpathSync
 * throws EOPNOTSUPP on Unix sockets (tmux servers) on macOS, and /tmp there
 * is a symlink to /private/tmp.
 */
export function sameFile(a: string, b: string): boolean {
	try {
		const left = statSync(a);
		const right = statSync(b);
		return left.dev === right.dev && left.ino === right.ino;
	} catch {
		return a === b;
	}
}
