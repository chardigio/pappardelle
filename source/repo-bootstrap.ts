import path from 'node:path';
import {homedir} from 'node:os';
import {getRepoName, getRepoRoot, loadProviderConfigs} from './config.ts';
import {loadEnvrcIntoProcessEnv} from './envrc.ts';
import {createIssueTracker, createVcsHost} from './providers/index.ts';
import {initStateColorCacheDir} from './providers/state-color-cache.ts';
import {initForRepo} from './space-registry.ts';

/**
 * Per-repo process setup shared by the TUI and its popup child. The popup is
 * a fresh node process, so anything the TUI set up at startup is missing
 * there until this runs again.
 */
export function bootstrapRepo(): {repoName: string} {
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
	initForRepo(repoName);
	initStateColorCacheDir(
		path.join(homedir(), '.pappardelle', 'repos', repoName),
	);

	// Initialize provider singletons from config so that all subsequent
	// no-arg calls (e.g. from tracker.ts facade) use the correct provider.
	// Uses loadProviderConfigs() instead of loadConfig() so that provider
	// initialization succeeds even when unrelated config sections (e.g.
	// profiles) have validation errors.
	try {
		const providerCfg = loadProviderConfigs();
		createIssueTracker(providerCfg.issue_tracker);
		createVcsHost(providerCfg.vcs_host);
	} catch {
		// If loading fails the providers will fall back to defaults on first use.
	}

	return {repoName};
}
