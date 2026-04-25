// Config loading and parsing for .pappardelle.yml
import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
	run?: string;
	send_to_claude?: string;
	disabled?: boolean;
}

export interface ClaudeConfig {
	initialization_command?: string;
	dangerously_skip_permissions?: boolean;
}

export interface HooksConfig {
	post_workspace_create?: CommandConfig[];
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

export interface IssueWatchlistConfig {
	assignee?: string; // Optional: username/email, or 'me' to auto-detect. Omit to match all assignees.
	statuses: string[]; // Issue statuses to match (e.g., ['To Do', 'In Progress'])
	labels?: string[]; // Optional: only match issues with any of these labels
}

export interface TerminalConfig {
	app?: string; // Default: "iTerm"
}

export interface Profile {
	keywords?: string[];
	/** Issue tracker project names that map to this profile (case-insensitive match). */
	tracker_projects?: string[];
	display_name: string;
	/**
	 * Optional emoji shown in the TUI ticket rail (left of the Claude status icon).
	 * Falls back to the top-level `default_emoji`.
	 */
	emoji?: string;
	/** Per-profile team prefix override. Falls back to the global `team_prefix`. */
	team_prefix?: string;
	/** Per-profile Claude config override. Falls back to the global `claude` section. */
	claude?: ClaudeConfig;
	/** Generic template variables injected into the workspace context. */
	vars?: Record<string, string>;
	github?: GitHubConfig;
	/** Provider-agnostic VCS config; falls back to `github` if absent. */
	vcs?: VcsConfig;
	links?: LinkConfig[];
	apps?: AppConfig[];
	/** Commands to run after worktree creation, after global post_workspace_init. */
	post_workspace_init?: CommandConfig[];
	/** @deprecated Use post_workspace_init instead. Accepted for backwards compat. */
	post_worktree_init?: CommandConfig[];
	/** Commands to run before workspace deletion. If any fails, deletion is aborted. */
	pre_workspace_deinit?: CommandConfig[];
	commands?: CommandConfig[];
}

export interface PappardelleConfig {
	version: number;
	default_profile?: string;
	/**
	 * Emoji shown in the ticket rail when the active profile has no `emoji` of
	 * its own (or no profile can be matched at all, e.g. for the main worktree).
	 */
	default_emoji?: string;
	team_prefix?: string;
	issue_tracker?: IssueTrackerConfig;
	vcs_host?: VcsHostConfig;
	claude?: ClaudeConfig;
	/** Poll the issue tracker for issues assigned to a user with matching statuses. */
	issue_watchlist?: IssueWatchlistConfig;
	/** Commands to run after git worktree is created. Same format as profile commands. */
	post_workspace_init?: CommandConfig[];
	/** @deprecated Use post_workspace_init instead. Accepted for backwards compat. */
	post_worktree_init?: CommandConfig[];
	/** Commands to run before workspace deletion. If any fails, deletion is aborted. */
	pre_workspace_deinit?: CommandConfig[];
	terminal?: TerminalConfig;
	hooks?: HooksConfig;
	keybindings?: KeybindingConfig[];
	profiles: Record<string, Profile>;
}

/**
 * Var key names that must not be used in profile `vars:` blocks.
 * Includes built-in template variables (which would be silently overwritten)
 * and critical shell variables (which would break the idow bash script).
 */
export const RESERVED_VAR_NAMES = new Set([
	// Built-in template variables
	'ISSUE_KEY',
	'ISSUE_URL',
	'ISSUE_NUMBER',
	'TITLE',
	'DESCRIPTION',
	'WORKTREE_PATH',
	'REPO_ROOT',
	'REPO_NAME',
	'PR_URL',
	'MR_URL',
	'SCRIPT_DIR',
	'GITHUB_LABEL',
	'VCS_LABEL',
	'TRACKER_PROVIDER',
	'VCS_PROVIDER',
	// Critical shell variables
	'PATH',
	'HOME',
	'IFS',
	'SHELL',
	'USER',
	'PWD',
	'OLDPWD',
	'LANG',
	'TERM',
	'TMPDIR',
]);

/**
 * Navigation and system keys that cannot be overridden by custom keybindings.
 */
export const NON_OVERRIDABLE_KEYS = new Set(['j', 'k', 'n', 'q', '?']);

/**
 * Keys with built-in default behavior that CAN be overridden by custom keybindings.
 * When overridden, the custom binding replaces the default action entirely.
 * Use `disabled: true` to suppress a default without adding a replacement.
 */
export const DEFAULT_KEYBINDING_KEYS = new Set(['g', 'i', 'd', 'o', 'e', 'p']);

/**
 * Union of NON_OVERRIDABLE_KEYS and DEFAULT_KEYBINDING_KEYS.
 * Kept for backwards compatibility and tests that need the full set.
 */
export const RESERVED_KEYS = new Set([
	...NON_OVERRIDABLE_KEYS,
	...DEFAULT_KEYBINDING_KEYS,
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
 * Merge local keybinding overrides on top of base keybindings.
 * - New keys are added
 * - Existing keys are replaced entirely
 * - Keys with `disabled: true` are removed from the active set
 */
export function mergeKeybindings(
	base: KeybindingConfig[],
	local: KeybindingConfig[],
): KeybindingConfig[] {
	const result = new Map(base.map(kb => [kb.key, kb]));
	for (const kb of local) {
		if (kb.disabled) {
			result.delete(kb.key);
		} else {
			result.set(kb.key, kb);
		}
	}

	return [...result.values()];
}

// ============================================================================
// Deep Merge & 3-Layer Config
// ============================================================================

/**
 * Deep-merge two plain objects. Later values override earlier ones.
 * - Objects are merged recursively
 * - Arrays and scalars are replaced entirely
 * - null/undefined overlay values replace the base value
 */
export function deepMerge(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {...base};
	for (const key of Object.keys(overlay)) {
		const baseVal = base[key];
		const overVal = overlay[key];
		if (
			overVal !== null &&
			overVal !== undefined &&
			typeof overVal === 'object' &&
			!Array.isArray(overVal) &&
			baseVal !== null &&
			baseVal !== undefined &&
			typeof baseVal === 'object' &&
			!Array.isArray(baseVal)
		) {
			result[key] = deepMerge(
				baseVal as Record<string, unknown>,
				overVal as Record<string, unknown>,
			);
		} else {
			result[key] = overVal;
		}
	}

	return result;
}

/**
 * Merge up to three config layers with proper override semantics.
 * Priority (lowest → highest): home → project → local.
 *
 * Uses deep merge for most fields. Keybindings use the smart
 * add/override/disable merge logic from `mergeKeybindings`.
 */
export function mergeConfigLayers(
	home: Record<string, unknown> | null,
	project: Record<string, unknown> | null,
	local: Record<string, unknown> | null,
): Record<string, unknown> {
	const layers = [home, project, local].filter(
		(l): l is Record<string, unknown> => l !== null && l !== undefined,
	);
	if (layers.length === 0) {
		return {};
	}

	// Start with the first layer, then merge each subsequent one
	let result: Record<string, unknown> = {...layers[0]!};
	for (let i = 1; i < layers.length; i++) {
		const layer = layers[i]!;

		// Extract keybindings before deep merge so we can smart-merge them
		const baseKb = result['keybindings'] as KeybindingConfig[] | undefined;
		const layerKb = layer['keybindings'] as KeybindingConfig[] | undefined;

		result = deepMerge(result, layer);

		// Smart-merge keybindings instead of replacing
		if (baseKb && layerKb) {
			result['keybindings'] = mergeKeybindings(baseKb, layerKb);
		}
	}

	return result;
}

/**
 * The default home config directory: ~/.pappardelle/
 */
export function getDefaultHomeConfigDir(): string {
	return path.join(os.homedir(), '.pappardelle');
}

/**
 * Load config from explicit paths, supporting the 3-layer merge:
 *   1. Home config   (homeConfigDir/.pappardelle.yml)
 *   2. Project config (projectDir/.pappardelle.yml)
 *   3. Local config   (projectDir/.pappardelle.local.yml)
 *
 * At least one layer must provide a config file, otherwise throws ConfigNotFoundError.
 */
export function loadConfigFromPaths(opts: {
	homeConfigDir?: string;
	projectDir?: string;
}): PappardelleConfig {
	const {homeConfigDir, projectDir} = opts;

	// Load each layer if its file exists
	let home: Record<string, unknown> | null = null;
	let project: Record<string, unknown> | null = null;
	let local: Record<string, unknown> | null = null;

	if (homeConfigDir) {
		const homePath = path.join(homeConfigDir, '.pappardelle.yml');
		if (fs.existsSync(homePath)) {
			try {
				const content = fs.readFileSync(homePath, 'utf-8');
				const parsed = YAML.load(content);
				if (parsed && typeof parsed === 'object') {
					home = parsed as Record<string, unknown>;
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new ConfigValidationError([
					`~/.pappardelle/.pappardelle.yml: ${msg}`,
				]);
			}
		}
	}

	if (projectDir) {
		const projectPath = path.join(projectDir, '.pappardelle.yml');
		if (fs.existsSync(projectPath)) {
			try {
				const content = fs.readFileSync(projectPath, 'utf-8');
				const parsed = YAML.load(content);
				if (parsed && typeof parsed === 'object') {
					project = parsed as Record<string, unknown>;
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new ConfigValidationError([`.pappardelle.yml: ${msg}`]);
			}
		}

		const localPath = path.join(projectDir, '.pappardelle.local.yml');
		if (fs.existsSync(localPath)) {
			try {
				const content = fs.readFileSync(localPath, 'utf-8');
				const parsed = YAML.load(content);
				if (parsed && typeof parsed === 'object') {
					local = parsed as Record<string, unknown>;
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new ConfigValidationError([`.pappardelle.local.yml: ${msg}`]);
			}
		}
	}

	if (!home && !project && !local) {
		throw new ConfigNotFoundError(projectDir ?? '(no project dir)');
	}

	const merged = mergeConfigLayers(home, project, local);
	validateConfig(merged);
	return merged as PappardelleConfig;
}

/**
 * Load the .pappardelle.yml config from the repository root.
 * Supports 3-layer merge: home (~/.pappardelle/.pappardelle.yml) →
 * project (.pappardelle.yml) → local (.pappardelle.local.yml).
 */
export function loadConfig(): PappardelleConfig {
	const repoRoot = getRepoRoot();
	return loadConfigFromPaths({
		homeConfigDir: getDefaultHomeConfigDir(),
		projectDir: repoRoot,
	});
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

	// Check default_profile (optional — falls back to first profile)
	if (
		cfg['default_profile'] !== undefined &&
		(typeof cfg['default_profile'] !== 'string' ||
			(cfg['default_profile'] as string).length === 0)
	) {
		errors.push('default_profile: must be a non-empty string when specified');
	}

	// Check default_emoji (optional)
	// Empty string is allowed and means "reserve the emoji slot but render
	// nothing in it" — useful when most profiles have an emoji and you want
	// the unmatched ones to align without showing a glyph.
	if (
		cfg['default_emoji'] !== undefined &&
		typeof cfg['default_emoji'] !== 'string'
	) {
		errors.push('default_emoji: must be a string when specified');
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
			if (
				cl['dangerously_skip_permissions'] !== undefined &&
				typeof cl['dangerously_skip_permissions'] !== 'boolean'
			) {
				errors.push('claude.dangerously_skip_permissions: must be a boolean');
			}
		}
	}

	// Check issue_watchlist (optional)
	if (cfg['issue_watchlist'] !== undefined) {
		if (
			typeof cfg['issue_watchlist'] !== 'object' ||
			cfg['issue_watchlist'] === null
		) {
			errors.push('issue_watchlist: must be an object');
		} else {
			const wl = cfg['issue_watchlist'] as Record<string, unknown>;
			if (wl['assignee'] !== undefined && typeof wl['assignee'] !== 'string') {
				errors.push('issue_watchlist.assignee: must be a string');
			}

			if (!Array.isArray(wl['statuses']) || wl['statuses'].length === 0) {
				errors.push('issue_watchlist.statuses: required non-empty array');
			} else {
				const statuses = wl['statuses'] as unknown[];
				for (let i = 0; i < statuses.length; i++) {
					if (typeof statuses[i] !== 'string') {
						errors.push(`issue_watchlist.statuses[${i}]: must be a string`);
					}
				}
			}

			if (wl['labels'] !== undefined) {
				if (!Array.isArray(wl['labels'])) {
					errors.push('issue_watchlist.labels: must be an array');
				} else {
					const labels = wl['labels'] as unknown[];
					for (let i = 0; i < labels.length; i++) {
						if (typeof labels[i] !== 'string') {
							errors.push(`issue_watchlist.labels[${i}]: must be a string`);
						}
					}
				}
			}
		}
	}

	// Check post_workspace_init / post_worktree_init (optional, mutually exclusive)
	if (
		cfg['post_workspace_init'] !== undefined &&
		cfg['post_worktree_init'] !== undefined
	) {
		errors.push(
			'post_workspace_init and post_worktree_init cannot both be specified (use post_workspace_init)',
		);
	}
	const globalPostInit =
		cfg['post_workspace_init'] ?? cfg['post_worktree_init'];
	if (globalPostInit !== undefined) {
		const label =
			cfg['post_workspace_init'] !== undefined
				? 'post_workspace_init'
				: 'post_worktree_init';
		if (!Array.isArray(globalPostInit)) {
			errors.push(`${label}: must be an array`);
		} else {
			const cmds = globalPostInit as Array<Record<string, unknown>>;
			for (let i = 0; i < cmds.length; i++) {
				const cmd = cmds[i]!;
				if (typeof cmd['run'] !== 'string') {
					errors.push(`${label}[${i}].run: required string field`);
				}
				if (
					cmd['continue_on_error'] !== undefined &&
					typeof cmd['continue_on_error'] !== 'boolean'
				) {
					errors.push(`${label}[${i}].continue_on_error: must be a boolean`);
				}
			}
		}
	}

	// Check pre_workspace_deinit (optional)
	if (cfg['pre_workspace_deinit'] !== undefined) {
		if (!Array.isArray(cfg['pre_workspace_deinit'])) {
			errors.push('pre_workspace_deinit: must be an array');
		} else {
			const cmds = cfg['pre_workspace_deinit'] as Array<
				Record<string, unknown>
			>;
			for (let i = 0; i < cmds.length; i++) {
				const cmd = cmds[i]!;
				if (typeof cmd['run'] !== 'string') {
					errors.push(`pre_workspace_deinit[${i}].run: required string field`);
				}
				if (
					cmd['continue_on_error'] !== undefined &&
					typeof cmd['continue_on_error'] !== 'boolean'
				) {
					errors.push(
						`pre_workspace_deinit[${i}].continue_on_error: must be a boolean`,
					);
				}
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
					if (NON_OVERRIDABLE_KEYS.has(k)) {
						errors.push(
							`keybindings[${i}].key: "${k}" conflicts with built-in shortcut`,
						);
					}
					if (seenKeys.has(k)) {
						errors.push(`keybindings[${i}].key: "${k}" is already bound`);
					}
					seenKeys.add(k);
				}

				// Disabled bindings only need a valid key
				if (binding['disabled'] === true) {
					continue;
				}
				if (typeof binding['name'] !== 'string') {
					errors.push(`keybindings[${i}].name: required string field`);
				}
				const hasRun = typeof binding['run'] === 'string';
				const hasSendToClaude = typeof binding['send_to_claude'] === 'string';
				if (!hasRun && !hasSendToClaude) {
					errors.push(
						`keybindings[${i}]: must have either 'run' or 'send_to_claude'`,
					);
				}
			}
		}
	}

	// Check profiles
	if (!cfg['profiles'] || typeof cfg['profiles'] !== 'object') {
		errors.push('profiles: required object field');
	} else {
		const profiles = cfg['profiles'] as Record<string, unknown>;

		// Check that default_profile exists (when specified)
		if (
			typeof cfg['default_profile'] === 'string' &&
			cfg['default_profile'].length > 0 &&
			!profiles[cfg['default_profile']]
		) {
			errors.push(
				`default_profile: profile "${cfg['default_profile']}" not found in profiles`,
			);
		}

		// If no default_profile specified, resolve it to the first profile key
		if (cfg['default_profile'] === undefined) {
			const firstKey = Object.keys(profiles)[0];
			if (firstKey) {
				(cfg as Record<string, unknown>)['default_profile'] = firstKey;
			}
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

	// keywords (optional — defaults to empty array)
	if (p['keywords'] !== undefined && !Array.isArray(p['keywords'])) {
		errors.push(`${prefix}.keywords: must be an array when specified`);
	} else if (p['keywords'] === undefined) {
		(p as Record<string, unknown>)['keywords'] = [];
	}

	// tracker_projects (optional)
	if (p['tracker_projects'] !== undefined) {
		if (!Array.isArray(p['tracker_projects'])) {
			errors.push(
				`${prefix}.tracker_projects: must be an array when specified`,
			);
		} else {
			const projects = p['tracker_projects'] as unknown[];
			for (let i = 0; i < projects.length; i++) {
				if (typeof projects[i] !== 'string') {
					errors.push(`${prefix}.tracker_projects[${i}]: must be a string`);
				}
			}
		}
	}

	if (typeof p['display_name'] !== 'string') {
		errors.push(`${prefix}.display_name: required string field`);
	}

	// Optional emoji. Empty string is allowed (renders as a blank slot that
	// still reserves the emoji width — useful for keeping rows aligned when
	// some profiles have an emoji and others don't).
	if (p['emoji'] !== undefined && typeof p['emoji'] !== 'string') {
		errors.push(`${prefix}.emoji: must be a string when specified`);
	}

	// Optional team_prefix
	if (p['team_prefix'] !== undefined && typeof p['team_prefix'] !== 'string') {
		errors.push(`${prefix}.team_prefix: must be a string`);
	}

	// Optional vars
	if (p['vars'] !== undefined) {
		if (typeof p['vars'] !== 'object' || p['vars'] === null) {
			errors.push(`${prefix}.vars: must be an object`);
		} else {
			const vars = p['vars'] as Record<string, unknown>;
			for (const [k, v] of Object.entries(vars)) {
				if (typeof v !== 'string') {
					errors.push(`${prefix}.vars.${k}: must be a string`);
				}

				if (RESERVED_VAR_NAMES.has(k)) {
					errors.push(
						`${prefix}.vars.${k}: reserved name (collides with built-in template variable or shell variable)`,
					);
				}
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

	// Optional per-profile claude config
	if (p['claude'] !== undefined) {
		if (typeof p['claude'] !== 'object' || p['claude'] === null) {
			errors.push(`${prefix}.claude: must be an object`);
		} else {
			const cl = p['claude'] as Record<string, unknown>;
			if (
				cl['initialization_command'] !== undefined &&
				typeof cl['initialization_command'] !== 'string'
			) {
				errors.push(
					`${prefix}.claude.initialization_command: must be a string`,
				);
			}
		}
	}

	// Optional per-profile post_workspace_init / post_worktree_init (mutually exclusive)
	if (
		p['post_workspace_init'] !== undefined &&
		p['post_worktree_init'] !== undefined
	) {
		errors.push(
			`${prefix}.post_workspace_init and post_worktree_init cannot both be specified (use post_workspace_init)`,
		);
	}
	const profilePostInit = p['post_workspace_init'] ?? p['post_worktree_init'];
	if (profilePostInit !== undefined) {
		const label =
			p['post_workspace_init'] !== undefined
				? 'post_workspace_init'
				: 'post_worktree_init';
		if (!Array.isArray(profilePostInit)) {
			errors.push(`${prefix}.${label}: must be an array`);
		} else {
			const cmds = profilePostInit as Array<Record<string, unknown>>;
			for (let i = 0; i < cmds.length; i++) {
				const cmd = cmds[i]!;
				if (typeof cmd['run'] !== 'string') {
					errors.push(`${prefix}.${label}[${i}].run: required string field`);
				}
				if (
					cmd['continue_on_error'] !== undefined &&
					typeof cmd['continue_on_error'] !== 'boolean'
				) {
					errors.push(
						`${prefix}.${label}[${i}].continue_on_error: must be a boolean`,
					);
				}
			}
		}
	}

	// Optional per-profile pre_workspace_deinit
	if (p['pre_workspace_deinit'] !== undefined) {
		if (!Array.isArray(p['pre_workspace_deinit'])) {
			errors.push(`${prefix}.pre_workspace_deinit: must be an array`);
		} else {
			const cmds = p['pre_workspace_deinit'] as Array<Record<string, unknown>>;
			for (let i = 0; i < cmds.length; i++) {
				const cmd = cmds[i]!;
				if (typeof cmd['run'] !== 'string') {
					errors.push(
						`${prefix}.pre_workspace_deinit[${i}].run: required string field`,
					);
				}
				if (
					cmd['continue_on_error'] !== undefined &&
					typeof cmd['continue_on_error'] !== 'boolean'
				) {
					errors.push(
						`${prefix}.pre_workspace_deinit[${i}].continue_on_error: must be a boolean`,
					);
				}
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
				if (
					cmd['continue_on_error'] !== undefined &&
					typeof cmd['continue_on_error'] !== 'boolean'
				) {
					errors.push(
						`${prefix}.commands[${i}].continue_on_error: must be a boolean`,
					);
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
	SCRIPT_DIR?: string;
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
	enforced: boolean;
}

/**
 * Find profiles that match the given input based on keywords.
 * Uses prefix matching (case-insensitive): a keyword matches if any input
 * word starts with it. For example, keyword "track" matches "tracking",
 * and keyword "SHOP-" matches "SHOP-313".
 *
 * Keyword enforcement: If a word in the input is followed by `!` (e.g. "music!"),
 * it enforces that the selected profile must match that keyword. When enforced
 * keywords are present, only profiles matching at least one enforced keyword are
 * returned, even if other profiles match non-enforced keywords.
 */
export function matchProfiles(
	config: PappardelleConfig,
	input: string,
): ProfileMatch[] {
	// Extract enforced words: words immediately followed by ! in the raw input
	// e.g. "music!" → "music", "stardust-jams!" → "stardust-jams"
	const enforcedWords: string[] = [];
	const enforcedRegex = /([a-z0-9][a-z0-9-]*)!/gi;
	let regexMatch;
	while ((regexMatch = enforcedRegex.exec(input)) !== null) {
		enforcedWords.push(regexMatch[1]!.toLowerCase());
	}

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

		for (const keyword of profile.keywords ?? []) {
			const kwLower = keyword.toLowerCase();
			// Split keyword on whitespace to detect multi-word keywords
			const kwParts = kwLower.split(/\s+/).filter(p => p.length > 0);

			if (kwParts.length === 0) continue;

			if (kwParts.length === 1) {
				// Prefix match: any input word starting with the keyword matches
				if (words.some(w => w.startsWith(kwLower))) {
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
				enforced: false,
			});
		}
	}

	// If there are enforced words, filter to only profiles matching an enforced keyword
	if (enforcedWords.length > 0) {
		const enforcedMatches = matches.filter(m =>
			m.matchedKeywords.some(kw => {
				const kwLower = kw.toLowerCase();
				// An enforced word matches a keyword if the enforced word starts with the keyword
				// (same prefix-matching logic as the main algorithm)
				return enforcedWords.some(ew => ew.startsWith(kwLower));
			}),
		);
		if (enforcedMatches.length > 0) {
			for (const m of enforcedMatches) {
				m.enforced = true;
			}
			enforcedMatches.sort((a, b) => b.score - a.score);
			return enforcedMatches;
		}
		// No enforced keywords matched any profile — fall through to normal behavior
	}

	// Sort by score descending
	matches.sort((a, b) => b.score - a.score);
	return matches;
}

/**
 * Find a profile that matches the given issue tracker project name.
 * Uses case-insensitive exact matching against each profile's `tracker_projects` list.
 * Returns the first matching profile, or null if no profile matches.
 */
export function matchProfileByProject(
	config: PappardelleConfig,
	projectName: string,
): {name: string; profile: Profile} | null {
	if (!projectName) return null;

	const projectLower = projectName.toLowerCase();

	for (const [name, profile] of Object.entries(config.profiles)) {
		if (
			profile.tracker_projects?.some(tp => tp.toLowerCase() === projectLower)
		) {
			return {name, profile};
		}
	}

	return null;
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

// Issue-key patterns used to short-circuit keyword matching and return the default profile.
const DETERMINE_PROFILE_ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const DETERMINE_PROFILE_ISSUE_NUMBER = /^\d+$/;
const DETERMINE_PROFILE_LINEAR_URL =
	/^https:\/\/linear\.app\/.+\/issue\/[A-Z][A-Z0-9]*-\d+/;

/**
 * Label shown in the TUI when profile selection is deferred to idow's
 * tracker_projects lookup (issue-key / bare-number / Linear-URL inputs).
 */
export const DEFERRED_PROFILE_DISPLAY_NAME = 'Determined by issue project';

export type ProfileSelection =
	| {
			kind: 'deferred';
			displayName: string;
	  }
	| {
			kind: 'resolved';
			name: string;
			displayName: string;
			isDefault: boolean;
			matchedKeywords: string[];
			enforced: boolean;
	  };

/**
 * Resolve the profile that should be used for a new-session input.
 *
 * Single source of truth for profile selection: both the TUI PromptDialog
 * and the spawned idow process route through this function (the TUI forwards
 * the chosen name via --profile) so the display and runtime selection can't
 * diverge when multiple profiles match.
 *
 * Returns:
 *  - null for empty/whitespace input
 *  - `{kind: 'deferred'}` for issue keys, bare numbers, or Linear URLs —
 *    the caller should NOT pass --profile to idow; idow will pick the
 *    profile based on the fetched issue's tracker project
 *  - `{kind: 'resolved'}` otherwise (keyword match or default fallback)
 */
export function determineProfileForInput(
	config: PappardelleConfig,
	input: string,
): ProfileSelection | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	if (
		DETERMINE_PROFILE_ISSUE_KEY.test(trimmed) ||
		DETERMINE_PROFILE_ISSUE_NUMBER.test(trimmed) ||
		DETERMINE_PROFILE_LINEAR_URL.test(trimmed)
	) {
		return {kind: 'deferred', displayName: DEFERRED_PROFILE_DISPLAY_NAME};
	}

	const matches = matchProfiles(config, trimmed);
	if (matches.length === 0) {
		const def = getDefaultProfile(config);
		return {
			kind: 'resolved',
			name: def.name,
			displayName: def.profile.display_name,
			isDefault: true,
			matchedKeywords: [],
			enforced: false,
		};
	}

	const best = matches[0]!;
	return {
		kind: 'resolved',
		name: best.name,
		displayName: best.profile.display_name,
		isDefault: false,
		matchedKeywords: best.matchedKeywords,
		enforced: best.enforced,
	};
}

/**
 * Get the default profile.
 * Uses `default_profile` if set, otherwise falls back to the first profile.
 */
export function getDefaultProfile(config: PappardelleConfig): {
	name: string;
	profile: Profile;
} {
	const name = config.default_profile ?? Object.keys(config.profiles)[0];
	if (!name) {
		throw new Error('No profiles defined');
	}
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
 * Get the emoji to display in the ticket rail for a profile.
 *
 * Resolution order:
 *   1. The profile's own `emoji:`
 *   2. The top-level `default_emoji:` (may be an empty string — that means
 *      "reserve the slot but render nothing")
 *   3. Footgun guard: if *any other* profile in the config has an `emoji:`,
 *      return `''` so unmatched rows (main worktree, issues without a
 *      project match) still reserve the slot and line up with their
 *      emoji-bearing siblings. Otherwise the user would set an emoji on
 *      one profile and silently get misaligned rows everywhere else.
 *   4. `undefined` — no emoji machinery anywhere in the config; the
 *      renderer skips the slot entirely and the TUI stays byte-identical
 *      to master for users who haven't opted in.
 */
export function getProfileEmoji(
	profile: Profile | undefined,
	config: PappardelleConfig,
): string | undefined {
	if (profile?.emoji !== undefined) return profile.emoji;
	if (config.default_emoji !== undefined) return config.default_emoji;
	const anyProfileHasEmoji = Object.values(config.profiles).some(
		p => p.emoji !== undefined,
	);
	return anyProfileHasEmoji ? '' : undefined;
}

/**
 * Get the Claude initialization command from config.
 * Returns the command string (e.g., "/idow") or empty string if not configured.
 */
export function getInitializationCommand(config: PappardelleConfig): string {
	return config.claude?.initialization_command ?? '';
}

/**
 * Get the Claude dangerously_skip_permissions flag from config.
 * Returns false if not configured (safe default).
 */
export function getDangerouslySkipPermissions(
	config: PappardelleConfig,
): boolean {
	return config.claude?.dangerously_skip_permissions ?? false;
}

/**
 * Get the issue watchlist config.
 * Returns undefined if not configured.
 */
export function getIssueWatchlist(
	config: PappardelleConfig,
): IssueWatchlistConfig | undefined {
	return config.issue_watchlist;
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
	configOverride?: PappardelleConfig,
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
		const config = configOverride ?? loadConfig();
		let profile: Profile | undefined;

		if (issueTitle) {
			const matches = matchProfiles(config, issueTitle);
			if (matches.length > 0) {
				profile = matches[0]!.profile;
			}
		}

		if (!profile && config.default_profile) {
			profile = config.profiles[config.default_profile];
		}

		if (profile?.vars) {
			Object.assign(vars, profile.vars);
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
