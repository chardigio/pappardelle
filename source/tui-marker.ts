import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

// A running TUI records itself in ~/.pappardelle/repos/<repo>/tui.json once it
// has rendered, so `pappardelle restart` can tell which build came up in the
// pane it respawned. restart.lock in the same directory keeps two restarts of
// one repo's TUI from overlapping.

export const DEFAULT_REPO_STATE_ROOT = path.join(
	homedir(),
	'.pappardelle',
	'repos',
);

export type TuiMarker = {
	pid: number;
	cliPath: string;
	sha: string;
	paneId: string;
	startedAt: number;
};

export function tuiMarkerPath(repoStateRoot: string, repo: string): string {
	return path.join(repoStateRoot, repo, 'tui.json');
}

export function writeTuiMarker(
	repoStateRoot: string,
	repo: string,
	marker: TuiMarker,
): void {
	const file = tuiMarkerPath(repoStateRoot, repo);
	mkdirSync(path.dirname(file), {recursive: true});
	// A reader polling mid-write must never see half a file.
	const temporary = `${file}.${marker.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(marker) + '\n');
	renameSync(temporary, file);
}

export function readTuiMarker(
	repoStateRoot: string,
	repo: string,
): TuiMarker | null {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(tuiMarkerPath(repoStateRoot, repo), 'utf8'),
		);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const {pid, cliPath, sha, paneId, startedAt} = parsed as Record<
			string,
			unknown
		>;
		if (
			typeof pid !== 'number' ||
			typeof cliPath !== 'string' ||
			typeof sha !== 'string' ||
			typeof paneId !== 'string' ||
			typeof startedAt !== 'number'
		) {
			return null;
		}

		return {pid, cliPath, sha, paneId, startedAt};
	} catch {
		return null;
	}
}

export function restartLockPath(repoStateRoot: string, repo: string): string {
	return path.join(repoStateRoot, repo, 'restart.lock');
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export type RestartLock =
	| {held: true; release: () => void}
	| {held: false; holder: number};

// One attempt. A lock left by a process that has died (a TUI restarting itself
// dies in its own respawn) is taken over.
export function tryRestartLock(
	repoStateRoot: string,
	repo: string,
	isAlive: (pid: number) => boolean = processIsAlive,
): RestartLock {
	const file = restartLockPath(repoStateRoot, repo);
	mkdirSync(path.dirname(file), {recursive: true});
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(file, `${process.pid}\n`, {flag: 'wx'});
			return {
				held: true,
				release() {
					try {
						unlinkSync(file);
					} catch {
						// Already gone.
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}

		let holder: number;
		try {
			holder = Number.parseInt(readFileSync(file, 'utf8'), 10);
		} catch {
			// Released between the write and the read.
			continue;
		}

		if (Number.isInteger(holder) && isAlive(holder)) {
			return {held: false, holder};
		}

		try {
			unlinkSync(file);
		} catch {
			// Another process took the stale lock over first.
		}
	}

	return {held: false, holder: Number.NaN};
}
