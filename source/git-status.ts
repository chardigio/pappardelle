// Git working tree status utilities
import {exec} from 'node:child_process';
import {promisify} from 'node:util';

const execAsync = promisify(exec);

/**
 * Check if a worktree has uncommitted changes (staged or unstaged).
 * Returns null on failure so refreshes can retain the last known status.
 */
export async function isWorktreeDirty(
	worktreePath: string,
): Promise<boolean | null> {
	try {
		const {stdout} = await execAsync('git status --porcelain', {
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
