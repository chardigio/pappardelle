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
