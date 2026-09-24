import {MAIN_WORKTREE_KEY} from './space-utils.ts';

/**
 * Build env object for spawning the idow script.
 * Passes PAPPARDELLE_PROJECT_ROOT so the shell scripts resolve config
 * from the user's project directory, not the pappardelle source repo, and
 * PAPPARDELLE_MAIN_REPO_ROOT so nothing downstream re-derives it — idow hands
 * it on to the workspace's tmux sessions, where the Claude Code hooks read it
 * instead of resolving the main checkout on every tool use.
 */
export function buildSpawnEnv(
	repoRoot: string,
	mainRepoRoot?: string,
): NodeJS.ProcessEnv {
	return {
		...process.env,
		PAPPARDELLE_PROJECT_ROOT: repoRoot,
		...(mainRepoRoot ? {PAPPARDELLE_MAIN_REPO_ROOT: mainRepoRoot} : {}),
	};
}

/**
 * Build the `-e` flags for `tmux new-session` on a space's claude and
 * companion sessions. Mirrors SESSION_ENV in start-claude-session.sh, which
 * covers sessions that idow makes; this covers the ones the TUI makes itself
 * (the main space, and any space whose sessions are gone after a reboot).
 *
 * The variables go on the session because the inner tmux server is long-lived:
 * its global environment is whatever the process that started it had.
 *
 * The main space gets no PAPPARDELLE_SPACE. Its checkout can change branch
 * while the session lives on, and the rail keys its dot by the branch, so a
 * fixed value would go stale. The hook's cwd logic already follows the branch.
 */
export function buildSessionEnvArgs(
	spaceKey: string,
	mainRepoRoot?: string,
): string[] {
	return [
		...(spaceKey === MAIN_WORKTREE_KEY
			? []
			: ['-e', `PAPPARDELLE_SPACE=${spaceKey}`]),
		...(mainRepoRoot
			? ['-e', `PAPPARDELLE_MAIN_REPO_ROOT=${mainRepoRoot}`]
			: []),
	];
}
