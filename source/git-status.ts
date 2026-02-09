// Git working tree status utilities
import {execSync} from 'node:child_process';

/**
 * Check if a worktree has uncommitted changes (staged or unstaged).
 * Returns false if the path doesn't exist or git fails (fail-safe: treat as clean).
 */
export function isWorktreeDirty(worktreePath: string): boolean {
	try {
		const output = execSync('git status --porcelain', {
			cwd: worktreePath,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return output.trim().length > 0;
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
