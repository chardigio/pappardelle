import {mkdirSync, readFileSync, statSync, watch} from 'node:fs';
import path from 'node:path';

// macOS reports some changes under another name (an atomic write's temporary
// file) or not at all, so a watch looks at the directory on every event and
// on this timer, never at the name an event carries.
const FALLBACK_POLL_MS = 2000;

/** Call `onChange` after anything in `dir` may have changed. */
export function watchDirChanges(dir: string, onChange: () => void): () => void {
	mkdirSync(dir, {recursive: true});
	const watcher = watch(dir, onChange);
	const poll = setInterval(onChange, FALLBACK_POLL_MS);
	poll.unref();
	return () => {
		clearInterval(poll);
		watcher.close();
	};
}

/** Identifies one write of a file: a rewrite or a replacement changes it. */
export function fileVersion(file: string): string | null {
	try {
		const stat = statSync(file);
		return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch {
		return null;
	}
}

/**
 * Call `callback` with the trimmed content of `filePath` each time it is
 * written after the watch begins.
 */
export function watchFileContent(
	filePath: string,
	callback: (content: string) => void,
): () => void {
	let seen = fileVersion(filePath);
	return watchDirChanges(path.dirname(filePath), () => {
		const version = fileVersion(filePath);
		if (version === seen) return;
		seen = version;
		if (version === null) return;
		try {
			const content = readFileSync(filePath, 'utf-8').trim();
			if (content) callback(content);
		} catch {
			// Deleted between the stat and the read
		}
	});
}

/**
 * Resolve when anything in `dirs` changes, or after `ms`, whichever is first.
 * Missing directories are created so there is something to watch.
 */
export async function waitForDirChange(
	dirs: readonly string[],
	ms: number,
): Promise<void> {
	return new Promise(resolve => {
		const watchers = dirs.map(dir => {
			mkdirSync(dir, {recursive: true});
			return watch(dir, done);
		});
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
			resolve();
		}
	});
}
