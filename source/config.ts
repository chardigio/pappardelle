// Config loading and parsing for .pappardelle.yml
import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'js-yaml';

// ============================================================================
// Types
// ============================================================================

export interface LinkConfig {
	url: string;
	title: string;
	if_set?: string;
}

export interface AppConfig {
	name: string;
	path?: string;
	command?: string;
	if_set?: string;
}

export interface CommandConfig {
	name: string;
	run: string;
	continue_on_error?: boolean;
	background?: boolean;
}

export interface KeybindingConfig {
	key: string;
	name: string;
	run: string;
}

export interface ClaudeConfig {
	initialization_command?: string;
}

export interface HooksConfig {
	post_workspace_create?: CommandConfig[];
}

export interface LayoutConfig {
	positions?: Record<string, number>;
}

export interface IOSConfig {
	app_dir: string;
	bundle_id: string;
	scheme: string;
	simulator?: string;
}

export interface GitHubConfig {
	label: string;
}

/**
 * Provider-agnostic VCS config for a profile.
 * New name for the github config; `github:` key still accepted as fallback.
 */
export interface VcsConfig {
	label: string;
}

export interface IssueTrackerConfig {
	provider: 'linear' | 'jira';
	base_url?: string; // Required for jira
}

export interface VcsHostConfig {
	provider: 'github' | 'gitlab';
	host?: string; // For self-hosted GitLab
}

export interface Profile {
	keywords: string[];
	display_name: string;
	/** Per-profile team prefix override. Falls back to the global `team_prefix`. */
	team_prefix?: string;
	ios?: IOSConfig;
	github?: GitHubConfig;
	/** Provider-agnostic VCS config; falls back to `github` if absent. */
	vcs?: VcsConfig;
	links?: LinkConfig[];
	apps?: AppConfig[];
	commands?: CommandConfig[];
	layout?: LayoutConfig;
}

export interface PappardelleConfig {
	version: number;
	default_profile: string;
	team_prefix?: string;
	issue_tracker?: IssueTrackerConfig;
	vcs_host?: VcsHostConfig;
	claude?: ClaudeConfig;
	hooks?: HooksConfig;
	keybindings?: KeybindingConfig[];
	profiles: Record<string, Profile>;
}

/**
 * Built-in keyboard shortcuts that cannot be overridden by custom keybindings.
 */
export const RESERVED_KEYS = new Set([
	'j',
	'k',
	'g',
	'i',
	'd',
	'o',
	'n',
	'e',
	'p',
	'?',
]);

export class ConfigNotFoundError extends Error {
	repoRoot: string;

	constructor(repoRoot: string) {
		super(`No .pappardelle.yml found at repository root: ${repoRoot}`);
		this.name = 'ConfigNotFoundError';
		this.repoRoot = repoRoot;
	}
}

export class ConfigValidationError extends Error {
	errors: string[];

	constructor(errors: string[]) {
		super(
			`Invalid .pappardelle.yml configuration:\n${errors
				.map(e => `  - ${e}`)
				.join('\n')}`,
		);
		this.name = 'ConfigValidationError';
		this.errors = errors;
	}
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Get the git repository root directory
 */
export function getRepoRoot(): string {
	try {
		return execSync('git rev-parse --show-toplevel', {
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
	} catch {
		throw new Error('Not in a git repository');
	}
}

/**
 * Extract the repository name from a git common dir path.
 * `git rev-parse --path-format=absolute --git-common-dir` returns the main
 * repo's `.git` directory even when run from a worktree, e.g.
 * `/Users/charlie/cs/stardust-labs/.git`. The parent directory's basename
 * is the repo name.
 */
export function repoNameFromGitCommonDir(gitCommonDir: string): string {
	// Strip trailing slash then get parent basename
	const normalized = gitCommonDir.replace(/\/+$/, '');
	return path.basename(path.dirname(normalized));
}

/**
 * Get the repository name, correctly resolving through worktrees.
 * Cached after first successful call — the repo name never changes during a session
 * and this avoids spawning `git rev-parse` on every poll cycle.
 */
let cachedRepoName: string | null = null;

export function getRepoName(): string {
	if (cachedRepoName) return cachedRepoName;

	try {
		const gitCommonDir = execSync(
			'git rev-parse --path-format=absolute --git-common-dir',
			{
				encoding: 'utf-8',
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		).trim();
		cachedRepoName = repoNameFromGitCommonDir(gitCommonDir);
		return cachedRepoName;
	} catch {
		throw new Error('Not in a git repository');
	}
}

/**
 * Qualify a main-worktree branch name with the repo name to avoid
 * collisions across repos (e.g. "stardust-labs-master" instead of "master").
 */
export function qualifyMainBranch(repoName: string, branch: string): string {
	return `${repoName}-${branch}`;
}

/**
 * Load the .pappardelle.yml config from the repository root
 */
export function loadConfig(): PappardelleConfig {
	const repoRoot = getRepoRoot();
	const configPath = path.join(repoRoot, '.pappardelle.yml');

	if (!fs.existsSync(configPath)) {
		throw new ConfigNotFoundError(repoRoot);
	}

	const content = fs.readFileSync(configPath, 'utf-8');
	const config = YAML.load(content) as PappardelleConfig;

	validateConfig(config);
	return config;
}

/**
 * Load just the provider configs (issue_tracker, vcs_host) from .pappardelle.yml.
 * Skips full config validation so providers can be initialized even when
 * unrelated config sections (e.g. profiles) have errors.
 */
export function loadProviderConfigs(): {
	issue_tracker?: IssueTrackerConfig;
	vcs_host?: VcsHostConfig;
} {
	const repoRoot = getRepoRoot();
	const configPath = path.join(repoRoot, '.pappardelle.yml');

	if (!fs.existsSync(configPath)) {
		return {};
	}

	const content = fs.readFileSync(configPath, 'utf-8');
	const raw = YAML.load(content) as Record<string, unknown>;
	return {
		issue_tracker: raw['issue_tracker'] as IssueTrackerConfig | undefined,
		vcs_host: raw['vcs_host'] as VcsHostConfig | undefined,
	};
}

/**
 * Check if a .pappardelle.yml exists at the repo root
 */
export function configExists(): boolean {
	try {
		const repoRoot = getRepoRoot();
		const configPath = path.join(repoRoot, '.pappardelle.yml');
		return fs.existsSync(configPath);
	} catch {
		return false;
	}
}

// ============================================================================
// Config Validation
// ============================================================================

export function validateConfig(
	config: unknown,
): asserts config is PappardelleConfig {
	const errors: string[] = [];

	if (!config || typeof config !== 'object') {
		throw new ConfigValidationError(['Config must be an object']);
	}

	const cfg = config as Record<string, unknown>;

	// Check version
	if (cfg['version'] !== 1) {
		errors.push('version: must be 1');
	}

	// Check default_profile
	if (
		typeof cfg['default_profile'] !== 'string' ||
		(cfg['default_profile'] as string).length === 0
	) {
		errors.push('default_profile: required string field');
	}

	// Check issue_tracker (optional)
	if (cfg['issue_tracker'] !== undefined) {
		if (
			typeof cfg['issue_tracker'] !== 'object' ||
			cfg['issue_tracker'] === null
		) {
			errors.push('issue_tracker: must be an object');
		} else {
			const it = cfg['issue_tracker'] as Record<string, unknown>;
			const provider = it['provider'];
			if (provider !== 'linear' && provider !== 'jira') {
				errors.push('issue_tracker.provider: must be "linear" or "jira"');
			} else if (provider === 'jira' && typeof it['base_url'] !== 'string') {
				errors.push('issue_tracker.base_url: required when provider is "jira"');
			}
		}
	}

	// Check vcs_host (optional)
	if (cfg['vcs_host'] !== undefined) {
		if (typeof cfg['vcs_host'] !== 'object' || cfg['vcs_host'] === null) {
			errors.push('vcs_host: must be an object');
		} else {
			const vh = cfg['vcs_host'] as Record<string, unknown>;
			const provider = vh['provider'];
			if (provider !== 'github' && provider !== 'gitlab') {
				errors.push('vcs_host.provider: must be "github" or "gitlab"');
			}
		}
	}

	// Check claude (optional)
	if (cfg['claude'] !== undefined) {
		if (typeof cfg['claude'] !== 'object' || cfg['claude'] === null) {
			errors.push('claude: must be an object');
		} else {
			const cl = cfg['claude'] as Record<string, unknown>;
			if (
				cl['initialization_command'] !== undefined &&
				typeof cl['initialization_command'] !== 'string'
			) {
				errors.push('claude.initialization_command: must be a string');
			}
		}
	}

	// Check hooks (optional)
	if (cfg['hooks'] !== undefined) {
		if (typeof cfg['hooks'] !== 'object' || cfg['hooks'] === null) {
			errors.push('hooks: must be an object');
		} else {
			const hooks = cfg['hooks'] as Record<string, unknown>;
			if (hooks['post_workspace_create'] !== undefined) {
				if (!Array.isArray(hooks['post_workspace_create'])) {
					errors.push('hooks.post_workspace_create: must be an array');
				} else {
					const cmds = hooks['post_workspace_create'] as Array<
						Record<string, unknown>
					>;
					for (let i = 0; i < cmds.length; i++) {
						const cmd = cmds[i]!;
						if (typeof cmd['run'] !== 'string') {
							errors.push(
								`hooks.post_workspace_create[${i}].run: required string field`,
							);
						}
					}
				}
			}
		}
	}

	// Check keybindings (optional)
	if (cfg['keybindings'] !== undefined) {
		if (!Array.isArray(cfg['keybindings'])) {
			errors.push('keybindings: must be an array');
		} else {
			const bindings = cfg['keybindings'] as Array<Record<string, unknown>>;
			const seenKeys = new Set<string>();
			for (let i = 0; i < bindings.length; i++) {
				const binding = bindings[i]!;
				if (
					typeof binding['key'] !== 'string' ||
					(binding['key'] as string).length !== 1
				) {
					errors.push(`keybindings[${i}].key: must be a single character`);
				} else {
					const k = binding['key'] as string;
					if (RESERVED_KEYS.has(k)) {
						errors.push(
							`keybindings[${i}].key: "${k}" conflicts with built-in shortcut`,
						);
					}
					if (seenKeys.has(k)) {
						errors.push(`keybindings[${i}].key: "${k}" is already bound`);
					}
					seenKeys.add(k);
				}
				if (typeof binding['name'] !== 'string') {
					errors.push(`keybindings[${i}].name: required string field`);
				}
				if (typeof binding['run'] !== 'string') {
					errors.push(`keybindings[${i}].run: required string field`);
				}
			}
		}
	}

	// Check profiles
	if (!cfg['profiles'] || typeof cfg['profiles'] !== 'object') {
		errors.push('profiles: required object field');
	} else {
		const profiles = cfg['profiles'] as Record<string, unknown>;

		// Check that default_profile exists
		if (cfg['default_profile'] && !profiles[cfg['default_profile'] as string]) {
			errors.push(
				`default_profile: profile "${cfg['default_profile']}" not found in profiles`,
			);
		}

		// Validate each profile
		for (const [name, profile] of Object.entries(profiles)) {
			const profileErrors = validateProfile(name, profile);
			errors.push(...profileErrors);
		}
	}

	if (errors.length > 0) {
		throw new ConfigValidationError(errors);
	}
}

function validateProfile(name: string, profile: unknown): string[] {
	const errors: string[] = [];
	const prefix = `profiles.${name}`;

	if (!profile || typeof profile !== 'object') {
		return [`${prefix}: must be an object`];
	}

	const p = profile as Record<string, unknown>;

	// Required fields
	if (!Array.isArray(p['keywords'])) {
		errors.push(`${prefix}.keywords: required array field`);
	}

	if (typeof p['display_name'] !== 'string') {
		errors.push(`${prefix}.display_name: required string field`);
	}

	// Optional team_prefix
	if (p['team_prefix'] !== undefined && typeof p['team_prefix'] !== 'string') {
		errors.push(`${prefix}.team_prefix: must be a string`);
	}

	// Optional iOS config
	if (p['ios'] !== undefined) {
		if (typeof p['ios'] !== 'object' || p['ios'] === null) {
			errors.push(`${prefix}.ios: must be an object`);
		} else {
			const ios = p['ios'] as Record<string, unknown>;
			if (typeof ios['app_dir'] !== 'string') {
				errors.push(`${prefix}.ios.app_dir: required string field`);
			}
			if (typeof ios['bundle_id'] !== 'string') {
				errors.push(`${prefix}.ios.bundle_id: required string field`);
			}
			if (typeof ios['scheme'] !== 'string') {
				errors.push(`${prefix}.ios.scheme: required string field`);
			}
		}
	}

	// Optional GitHub config
	if (p['github'] !== undefined) {
		if (typeof p['github'] !== 'object' || p['github'] === null) {
			errors.push(`${prefix}.github: must be an object`);
		} else {
			const gh = p['github'] as Record<string, unknown>;
			if (typeof gh['label'] !== 'string') {
				errors.push(`${prefix}.github.label: required string field`);
			}
		}
	}

	// Optional commands array
	if (p['commands'] !== undefined) {
		if (!Array.isArray(p['commands'])) {
			errors.push(`${prefix}.commands: must be an array`);
		} else {
			const commands = p['commands'] as Array<Record<string, unknown>>;
			for (let i = 0; i < commands.length; i++) {
				const cmd = commands[i]!;
				if (typeof cmd['run'] !== 'string') {
					errors.push(`${prefix}.commands[${i}].run: required string field`);
				}
			}
		}
	}

	return errors;
}

// ============================================================================
// Template Expansion
// ============================================================================

export interface TemplateVars {
	ISSUE_KEY: string;
	ISSUE_URL?: string;
	TITLE?: string;
	DESCRIPTION?: string;
	WORKTREE_PATH: string;
	REPO_ROOT: string;
	REPO_NAME: string;
	PR_URL?: string;
	/** Provider-agnostic alias for PR_URL */
	MR_URL?: string;
	XCODEPROJ_PATH?: string;
	SCRIPT_DIR?: string;
	IOS_APP_DIR?: string;
	BUNDLE_ID?: string;
	SCHEME?: string;
	GITHUB_LABEL?: string;
	/** Provider-agnostic alias for GITHUB_LABEL */
	VCS_LABEL?: string;
	/** Issue tracker provider name (e.g., "linear", "jira") */
	TRACKER_PROVIDER?: string;
	/** VCS host provider name (e.g., "github", "gitlab") */
	VCS_PROVIDER?: string;
	[key: string]: string | undefined;
}

/**
 * Expand template variables in a string
 * Supports ${VAR_NAME} syntax and falls back to environment variables
 */
export function expandTemplate(template: string, vars: TemplateVars): string {
	return template.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
		// First check provided vars
		if (vars[varName] !== undefined) {
			return vars[varName]!;
		}
		// Then check environment variables
		if (process.env[varName] !== undefined) {
			return process.env[varName]!;
		}
		// Return empty string for unset variables
		return '';
	});
}

/**
 * Check if a conditional field should be included
 */
export function shouldInclude(
	ifSet: string | undefined,
	vars: TemplateVars,
): boolean {
	if (!ifSet) {
		return true;
	}
	const value = vars[ifSet] ?? process.env[ifSet];
	return value !== undefined && value !== '';
}

// ============================================================================
// Profile Selection
// ============================================================================

export interface ProfileMatch {
	name: string;
	profile: Profile;
	score: number;
	matchedKeywords: string[];
}

/**
 * Find profiles that match the given input based on keywords.
 * Uses exact word matching (case-insensitive) to avoid false positives.
 * Keywords ending with a hyphen (e.g. "SHOP-") act as prefix matchers,
 * so "SHOP-313" will match the keyword "SHOP-".
 */
export function matchProfiles(
	config: PappardelleConfig,
	input: string,
): ProfileMatch[] {
	// Split on whitespace and common punctuation, filter out empty strings
	// This handles cases like "pappardelle,now", "fix.something", "(keyword)", etc.
	// The regex splits on: whitespace, common punctuation, brackets, quotes, and operators
	// Note: We strip leading/trailing special chars from each word to handle cases like
	// "(pappardelle)" -> "pappardelle" while preserving internal hyphens like "stardust-jams"
	const words = input
		.toLowerCase()
		.split(/[\s,;:.!?|&/\\@=+]+/)
		.map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''))
		.filter(w => w.length > 0);

	// Early return for empty input
	if (words.length === 0) {
		return [];
	}

	const matches: ProfileMatch[] = [];

	for (const [name, profile] of Object.entries(config.profiles)) {
		const matchedKeywords: string[] = [];

		for (const keyword of profile.keywords) {
			const kwLower = keyword.toLowerCase();
			// Split keyword on whitespace to detect multi-word keywords
			const kwParts = kwLower.split(/\s+/).filter(p => p.length > 0);

			if (kwParts.length === 0) continue;

			if (kwParts.length === 1) {
				if (kwLower.endsWith('-')) {
					// Prefix keyword (e.g. "SHOP-"): match any word starting with it
					if (words.some(w => w.startsWith(kwLower))) {
						matchedKeywords.push(keyword);
					}
				} else if (words.some(w => w === kwLower)) {
					// Single-word keyword: exact word match (case-insensitive)
					matchedKeywords.push(keyword);
				}
			} else {
				// Multi-word keyword: match adjacent words in input
				for (let i = 0; i <= words.length - kwParts.length; i++) {
					if (kwParts.every((part, j) => words[i + j] === part)) {
						matchedKeywords.push(keyword);
						break;
					}
				}
			}
		}

		if (matchedKeywords.length > 0) {
			matches.push({
				name,
				profile,
				score: matchedKeywords.length,
				matchedKeywords,
			});
		}
	}

	// Sort by score descending
	matches.sort((a, b) => b.score - a.score);
	return matches;
}

/**
 * Get a profile by name
 */
export function getProfile(
	config: PappardelleConfig,
	name: string,
): Profile | undefined {
	return config.profiles[name];
}

/**
 * Get the default profile
 */
export function getDefaultProfile(config: PappardelleConfig): {
	name: string;
	profile: Profile;
} {
	const name = config.default_profile;
	const profile = config.profiles[name];
	if (!profile) {
		throw new Error(`Default profile "${name}" not found`);
	}
	return {name, profile};
}

/**
 * Get the team prefix for issue identifiers (e.g., 'STA' for 'STA-123')
 * Defaults to 'STA' if not configured
 */
export function getTeamPrefix(config: PappardelleConfig): string {
	const prefix = config.team_prefix ?? 'STA';
	return prefix.toUpperCase();
}

/**
 * Get the effective team prefix for a specific profile.
 * Uses the profile's `team_prefix` if set, otherwise falls back to the global config.
 */
export function getProfileTeamPrefix(
	profile: Profile,
	config: PappardelleConfig,
): string {
	const prefix = profile.team_prefix ?? config.team_prefix ?? 'STA';
	return prefix.toUpperCase();
}

/**
 * List all available profiles
 */
export function listProfiles(
	config: PappardelleConfig,
): Array<{name: string; displayName: string}> {
	return Object.entries(config.profiles).map(([name, profile]) => ({
		name,
		displayName: profile.display_name,
	}));
}

/**
 * Get the VCS label for a profile (e.g., GitHub PR label).
 * Checks `vcs.label` first, then falls back to `github.label`.
 */
export function getProfileVcsLabel(profile: Profile): string | undefined {
	return profile.vcs?.label ?? profile.github?.label;
}

/**
 * Get the Claude initialization command from config.
 * Returns the command string (e.g., "/idow") or empty string if not configured.
 */
export function getInitializationCommand(config: PappardelleConfig): string {
	return config.claude?.initialization_command ?? '';
}

/**
 * Get custom keybindings from config.
 * Returns an empty array if none are configured.
 */
export function getKeybindings(config: PappardelleConfig): KeybindingConfig[] {
	return config.keybindings ?? [];
}

/**
 * Build template variables for a workspace, using profile-specific vars when available.
 * Tries to match the space's issue title against profiles to get iOS config etc.
 */
export function buildWorkspaceTemplateVars(
	issueKey: string,
	worktreePath: string,
	issueTitle?: string,
): TemplateVars {
	const repoRoot = getRepoRoot();
	const repoName = getRepoName();

	const vars: TemplateVars = {
		ISSUE_KEY: issueKey,
		WORKTREE_PATH: worktreePath,
		REPO_ROOT: repoRoot,
		REPO_NAME: repoName,
		SCRIPT_DIR: path.resolve(__dirname, '..', 'scripts'),
	};

	// Try to match a profile for additional template vars
	try {
		const config = loadConfig();
		let profile: Profile | undefined;

		if (issueTitle) {
			const matches = matchProfiles(config, issueTitle);
			if (matches.length > 0) {
				profile = matches[0]!.profile;
			}
		}

		if (!profile) {
			profile = config.profiles[config.default_profile];
		}

		if (profile?.ios) {
			vars.IOS_APP_DIR = profile.ios.app_dir;
			vars.BUNDLE_ID = profile.ios.bundle_id;
			vars.SCHEME = profile.ios.scheme;
			vars.XCODEPROJ_PATH = `${worktreePath}/${profile.ios.app_dir}/${profile.ios.scheme}.xcodeproj`;
		}

		if (profile) {
			const vcsLabel = getProfileVcsLabel(profile);
			if (vcsLabel) {
				vars.VCS_LABEL = vcsLabel;
				vars.GITHUB_LABEL = vcsLabel;
			}
		}
	} catch {
		// Config load failed — continue with basic vars
	}

	return vars;
}

// Directory of this file (used by buildWorkspaceTemplateVars for SCRIPT_DIR)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
