import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether a test run drops an inherited variable. A run started inside a
 * space, or by a timer service, inherits that space's PAPPARDELLE_*, and the
 * state ones (PAPPARDELLE_STATE_DB, PAPPARDELLE_STATUS_SOCKET, ...) point past
 * any HOME at the real database. A test run keeps only its state mode and its
 * own PAPPARDELLE_TEST_* switches.
 */
export function isHostPappardelleEnv(name: string): boolean {
	return (
		name.startsWith('PAPPARDELLE_') &&
		name !== 'PAPPARDELLE_SQLITE_STATE' &&
		!name.startsWith('PAPPARDELLE_TEST_')
	);
}

const droppedForTestRuns = new Set([
	// TMUX makes a tmux client talk to the server the run was started from.
	'TMUX',
	'TMUX_PANE',
	// These move the agents' config dirs off HOME, so they would point tests
	// at the developer's own Claude and Codex config.
	'CLAUDE_CONFIG_DIR',
	'CODEX_HOME',
	// tmux reads its config from XDG_CONFIG_HOME, so these would bring the
	// developer's config back past the throwaway HOME.
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'XDG_CACHE_HOME',
]);

/**
 * A HOME for one test run, so nothing it starts reads or writes the
 * developer's ~/.pappardelle, ~/.claude.json or shell history. Under /tmp:
 * the sockets tests create under HOME would pass the ~104-byte unix socket
 * limit under macOS's long os.tmpdir().
 */
export function makeThrowawayHome(): string {
	const home = fs.mkdtempSync('/tmp/ph-');
	// Without a .zshrc, a zsh started in a test's tmux pane opens its first-run
	// wizard, which takes the keys the test types.
	fs.writeFileSync(path.join(home, '.zshrc'), '');
	return home;
}

/**
 * The environment a test run starts its processes with: `source` with
 * nothing that leads back to the developer's own tmux servers, agent config or
 * state, and `home` as HOME. Bun reads HOME once at startup, so it has to be
 * in the environment the process starts with.
 */
export function testRunEnv(
	home: string,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(source).filter(
				([name]) =>
					!isHostPappardelleEnv(name) && !droppedForTestRuns.has(name),
			),
		),
		HOME: home,
		// zsh reads its rc files from ZDOTDIR, past HOME.
		ZDOTDIR: home,
		// Every git commit and fetch otherwise detaches a `git maintenance run
		// --auto`, which can still be writing into a test's repo after the test
		// removed it. Set through the environment rather than HOME's .gitconfig
		// so it also reaches the gits that tests start under a HOME of their own.
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'maintenance.auto',
		GIT_CONFIG_VALUE_0: 'false',
	};
}

/** Copy `source` without the variables {@link isHostPappardelleEnv} drops. */
export function stripHostPappardelleEnv(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(source).filter(([key]) => !isHostPappardelleEnv(key)),
	);
}
