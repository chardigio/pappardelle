// Git working tree status utilities
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/** The branch checked out in a working tree. git exits 1 when HEAD is detached. */
export async function readCurrentBranch(
	git: (args: string[]) => Promise<string>,
): Promise<string> {
	return git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

/**
 * Check if a worktree has uncommitted changes (staged or unstaged).
 * Returns null on failure so refreshes can retain the last known status.
 */
export async function isWorktreeDirty(
	worktreePath: string,
): Promise<boolean | null> {
	try {
		const {stdout} = await execFileAsync('git', ['status', '--porcelain'], {
			cwd: worktreePath,
			encoding: 'utf-8',
			timeout: 5000,
		});
		return stdout.trim().length > 0;
	} catch {
		return null;
	}
}

/**
 * Get the color for the main worktree key based on git status.
 * Caller provides the dirty/clean colors (typically from Linear workflow states).
 */
export function getMainWorktreeColor(
	isDirty: boolean,
	dirtyColor: string,
	cleanColor: string,
): string {
	return isDirty ? dirtyColor : cleanColor;
}
