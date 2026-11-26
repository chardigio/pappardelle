import {bunForChildren, isStandalone} from './runtime.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

/**
 * Build env object for spawning the idow script.
 * Passes PAPPARDELLE_PROJECT_ROOT so the shell scripts resolve config
 * from the user's project directory, not the pappardelle source repo, and
 * PAPPARDELLE_MAIN_REPO_ROOT so nothing downstream re-derives it — idow hands
 * it on to the workspace's tmux sessions, where the Claude Code hooks read it
 * instead of resolving the main checkout on every tool use.
 *
 * PAPPARDELLE_REGISTER_SPACE tells idow that a Pappardelle that lists spaces
 * started it, so idow records the space before it starts any session.
 */
export function buildSpawnEnv(
	repoRoot: string,
	mainRepoRoot: string,
): NodeJS.ProcessEnv {
	return {
		...process.env,
		PAPPARDELLE_BUN: bunForChildren(),
		PAPPARDELLE_EXECUTABLE: isStandalone ? process.execPath : undefined,
		PAPPARDELLE_PROJECT_ROOT: repoRoot,
		PAPPARDELLE_REGISTER_SPACE: '1',
		PAPPARDELLE_MAIN_REPO_ROOT: mainRepoRoot,
	};
}

/**
 * Build the `-e` flags for `tmux new-session` on a space's claude and
 * companion sessions. Mirrors SESSION_ENV in start-agent-session.sh, which
 * covers sessions that idow makes; this covers the ones the TUI makes itself
 * (the main space, and any space whose sessions are gone after a reboot).
 *
 * The variables go on the session because the inner tmux server is long-lived:
 * its global environment is whatever the process that started it had.
 *
 * PAPPARDELLE_REPO qualifies the hook's status key, since spaces of two repos
 * can share a key.
 *
 * The main space gets no PAPPARDELLE_SPACE: the hook finds main from its
 * stored worktree.
 */
export function buildSessionEnvArgs(
	spaceKey: string,
	repoName: string,
	mainRepoRoot?: string,
): string[] {
	return [
		'-e',
		`PAPPARDELLE_REPO=${repoName}`,
		...(spaceKey === MAIN_WORKTREE_KEY
			? []
			: ['-e', `PAPPARDELLE_SPACE=${spaceKey}`]),
		...(mainRepoRoot
			? ['-e', `PAPPARDELLE_MAIN_REPO_ROOT=${mainRepoRoot}`]
			: []),
	];
}

/**
 * The `-e` flags only the agent session gets, mirroring AGENT_SESSION_ENV in
 * start-agent-session.sh. The agent profile's env comes first, so
 * pappardelle's own variables win a name clash (tmux keeps the last). Pi and
 * agy report their status to the pane monitor only when asked, since tmux
 * cannot answer the terminal probe they would otherwise send; the monitor
 * captures the reports without changing the terminal transport.
 */
export function buildAgentSessionEnvArgs(
	profileEnv: Record<string, string> = {},
): string[] {
	return [
		...Object.entries(profileEnv).flatMap(([name, value]) => [
			'-e',
			`${name}=${value}`,
		]),
		'-e',
		'PI_PROGRAM_STATUS=1',
		'-e',
		'AGY_CLI_OSC7501=on',
	];
}
