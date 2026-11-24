import {
	getRepoName,
	getRepoRoot,
	inlineConfigErrors,
	loadProviderConfigs,
	readHomeSqliteState,
} from './config.ts';
import {loadEnvrcIntoProcessEnv} from './envrc.ts';
import {
	createIssueTracker,
	createVcsHost,
	setIssueTitles,
	setPrLinkStamp,
	setStateColors,
	setWorkspaceDiscovery,
} from './providers/index.ts';
import {discoverWorkspaceRepositories} from './providers/workspace-repositories.ts';
import {stateDaosByRepo, type StateDaos} from './state-daos.ts';
import {recordSqliteState} from './state-flag.ts';
import {initTmuxState} from './tmux.ts';
import {createLogger} from './logger.ts';

const log = createLogger('repo-bootstrap');

/**
 * Per-repo process setup shared by the TUI and its popup child. The popup is
 * a fresh Bun process, so anything the TUI set up at startup is missing
 * there until this runs again.
 */
export function bootstrapRepo(): {repoName: string; daos: StateDaos} {
	// Load $REPO_ROOT/.envrc (plain `export KEY=VAL` lines) into process.env so
	// per-repo Linear credentials and similar reach the providers even when
	// pappardelle was launched from a shell or tmux server that didn't have
	// direnv hooked. Mirrors STA-1422's idow-level fix one layer up so the TUI's
	// bulk GraphQL fetch — which reads LINCTL_API_KEY from process.env — uses
	// the right workspace's key instead of falling back to ~/.linctl-auth.json.
	// Existing process.env values win; .envrc only fills gaps.
	loadEnvrcIntoProcessEnv(getRepoRoot());

	// Initialize per-repo state directories so state is kept separate
	// from other repos that may also use pappardelle.
	const repoName = getRepoName();
	const daosByRepo = stateDaosByRepo();
	const daos = daosByRepo(repoName);
	initTmuxState(daos);
	setWorkspaceDiscovery(async (directory, host) =>
		discoverWorkspaceRepositories(
			directory,
			host,
			repo => daosByRepo(repo).spaceState,
		),
	);
	setStateColors(daos.stateColors);
	setPrLinkStamp(daos.prLinkStamp);
	setIssueTitles(daos.spaceState);

	try {
		recordSqliteState(readHomeSqliteState());
	} catch {
		// The hooks keep the mode they last read.
	}

	// Initialize provider singletons from config so that all subsequent
	// no-arg calls (e.g. from tracker.ts facade) use the correct provider.
	// Uses loadProviderConfigs() instead of loadConfig() so that provider
	// initialization succeeds even when unrelated config sections (e.g.
	// profiles) have validation errors.
	try {
		const providerCfg = loadProviderConfigs();
		if (providerCfg.unparsable.length > 0)
			log.error(
				`The tracker and VCS host settings of a config file that failed to parse are ignored: ${inlineConfigErrors(providerCfg.unparsable)}`,
			);
		createIssueTracker(providerCfg.issue_tracker);
		createVcsHost(providerCfg.vcs_host);
	} catch (error) {
		log.error(
			'Could not set up the tracker and VCS host; using the defaults',
			error instanceof Error ? error : undefined,
		);
	}

	return {repoName, daos};
}
