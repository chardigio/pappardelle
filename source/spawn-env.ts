/**
 * Build env object for spawning the idow script.
 * Passes PAPPARDELLE_PROJECT_ROOT so the shell scripts resolve config
 * from the user's project directory, not the pappardelle source repo.
 */
export function buildSpawnEnv(repoRoot: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PAPPARDELLE_PROJECT_ROOT: repoRoot,
	};
}
