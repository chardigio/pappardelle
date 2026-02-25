// Git working tree status utilities
import {exec} from 'node:child_process';
import {promisify} from 'node:util';

const execAsync = promisify(exec);

/**
 * Check if a worktree has uncommitted changes (staged or unstaged).
 * Returns false if the path doesn't exist or git fails (fail-safe: treat as clean).
 */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
	try {
		const {stdout} = await execAsync('git status --porcelain', {
			cwd: worktreePath,
			encoding: 'utf-8',
			timeout: 5000,
		});
		return stdout.trim().length > 0;
	} catch {
		return false;
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
