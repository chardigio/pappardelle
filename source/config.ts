// Config loading and parsing for .pappardelle.yml
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scriptsDir} from './runtime.ts';
import {parse as parseYaml, parseDocument} from 'yaml';
import {
	railGroupsFromConfig,
	type RailGroup,
	type RailGroupConfig,
} from './rail-groups.ts';
import {
	isBeadsIssueKey,
	issueKeyPrefix,
	issueKeyTeamPrefix,
} from './issue-utils.ts';
import type {TrackerProviderName, VcsProviderName} from './providers/types.ts';
import type {PaneWidth, PaneWidths} from './layout-sizing.ts';
import {DEFAULT_SPLIT, type SplitDirection} from './companion-splits.ts';
import {logger} from './logger.ts';
import {unwrapBeadsJson} from './providers/beads-json.ts';
import {
	ConfigNotFoundError,
	ConfigValidationError,
	NotInGitRepoError,
} from './config-errors.ts';
import {
	initializationCommandConflictErrors,
	renameDeprecatedInitializationCommand,
	warnDeprecatedClaudeFields,
} from './config-deprecation.ts';
import {
	builtinAgentDefaults,
	isClaudeAgentProfile,
	supportsSousChefPrompt,
	type LaunchField,
} from './config-launch-flags.ts';
import {configErrors} from './config-validation.ts';

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
	/** Text typed into the agent pane as-is. */
	send_to_claude?: string;
	/** A skill name, sent with the space's agent's skill prefix. */
	send_skill?: string;
	disabled?: boolean;
}

export interface ClaudeConfig {
	/** @deprecated Use the top-level / profile-level `initialization_command` instead. Accepted for backwards compat. */
	initialization_command?: string;
	dangerously_skip_permissions?: boolean;
	/**
	 * @deprecated Set `model` on an agent profile instead. Still read as the
	 * fallback for claude agent profiles that set no model of their own; see
	 * `getAgentProfile`.
	 */
	model?: string;
	/**
	 * @deprecated Set `effort` on an agent profile instead. Same fallback as
	 * `model`.
	 */
	effort?: string;
	/**
	 * @deprecated Set `args` on an agent profile instead. Raw flags for claude
	 * agent profiles, each shell-quoted on its own, placed after the
	 * model/effort flags. A profile that runs with no human watching
	 * (robodogfood, STA-2663) takes tools away from the agent with `--tools`,
	 * `--strict-mcp-config` and `--no-chrome`.
	 *
	 * A profile list replaces the top-level list; it never adds to it, so
	 * `extra_args: []` on a profile clears an inherited list. An agent
	 * profile's own `args` don't replace it, so a restricted profile keeps its
	 * limits under any claude agent profile.
	 */
	extra_args?: string[];
}

/**
 * A named agent profile: how to launch the agent in the agent pane. The
 * `agent_profiles:` map is where these live; workspace profiles (and the top
 * level) select one by name via `agent_profile:`.
 *
 * `args` and `resume_args` are free-form strings appended verbatim — codex's
 * `--yolo` goes in `args`. The agents in scripts/builtin-agents.json get
 * whichever flag templates, resume args and skill prefix their entry has,
 * unless the profile sets them. When the agent is claude, pappardelle
 * additionally injects its claude-specific flags (see `getAgentProfile`).
 */
export interface AgentProfileConfig {
	/** Base binary or command (required), e.g. `codex` or `/usr/local/bin/claude`. */
	command: string;
	/** Appended to every invocation (launch and resume). */
	args?: string;
	/**
	 * Appended for the resume attempt of the resume-then-launch chain.
	 * `{session_id}` is replaced with the session id the agent's hook recorded
	 * for the space (see plugins/pappardelle/hooks/agent_session.py); with none recorded, the
	 * resume attempt is skipped (claude falls back to `--continue`). Built in
	 * where the agent's entry in scripts/builtin-agents.json has one; any
	 * other agent defaults to none, which skips the resume attempt entirely
	 * (a made-up resume flag would error confusingly on unknown CLIs). `''`
	 * opts out.
	 */
	resume_args?: string;
	/**
	 * Force or suppress claude treatment (pre-trust, --name/model/effort/dsp
	 * injection, resume default) regardless of the command's basename.
	 * Lets a wrapper like `claude-local` opt in, or a binary that happens to
	 * be named `claude` opt out. Unset ⇒ basename-of-first-token == 'claude'.
	 */
	is_claude?: boolean;
	/**
	 * Model to launch the agent with, substituted into `model_args`. Accepts
	 * whatever the CLI accepts (an alias like "opus" or a full id like
	 * "claude-opus-5[1m]"): the set of valid names changes faster than this
	 * schema, so a typo surfaces when the CLI rejects it. `''` passes no flag.
	 */
	model?: string;
	/** Reasoning effort to launch the agent with, substituted into `effort_args`. */
	effort?: string;
	/** Execution mode to launch the agent with, substituted into `mode_args`. */
	mode?: string;
	/**
	 * How `model` reaches the CLI, with `{model}` standing in for the value.
	 * Built in where the agent's entry in scripts/builtin-agents.json has one;
	 * any other CLI needs it set before `model` can be used.
	 */
	model_args?: string;
	/**
	 * How `effort` reaches the CLI, with `{effort}` standing in for the value.
	 * Built in where the agent's entry in scripts/builtin-agents.json has one.
	 */
	effort_args?: string;
	/**
	 * How `mode` reaches the CLI, with `{mode}` standing in for the value.
	 * Built in for agy (`--mode {mode}`).
	 */
	mode_args?: string;
	/**
	 * How the launch prompt reaches the CLI, with `{prompt}` standing in for
	 * it exactly once, e.g. `-i {prompt}` for a CLI that won't take a bare
	 * prompt. Built in for agy. Unset otherwise ⇒ the prompt is the last bare
	 * argument.
	 */
	prompt_args?: string;
	/**
	 * What goes before a skill name when pappardelle invokes one: the
	 * `initialization_command` at launch and `send_skill` keybindings. Codex
	 * runs skills as `$name` but keeps `/` for its own commands, so the prefix
	 * belongs to the agent. Built in per agent (`$` for codex), else `/`.
	 */
	skill_prefix?: string;
	/**
	 * Environment variables set on the agent session when it is created, so
	 * they reach the launch and the resume attempt alike. Merged per variable
	 * across config layers. Space-only variables belong on the profiles spaces
	 * select, not the top-level `agent_profile` the sous-chef launches with.
	 */
	env?: Record<string, string>;
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
	provider: TrackerProviderName;
	base_url?: string; // Required for jira
}

export interface VcsHostConfig {
	provider: VcsProviderName;
	host?: string; // For self-hosted GitLab
}

export interface IssueWatchlistConfig {
	assignee?: string; // Optional: username/email, or 'me' to auto-detect. Omit to match all assignees.
	statuses: string[]; // Issue statuses to match (e.g., ['To Do', 'In Progress'])
	labels?: string[]; // Optional: only match issues with any of these labels
	/**
	 * Optional allowlist of issue-key prefixes (the part before the first '-',
	 * e.g. 'STA' in 'STA-123'). When set, only issues whose key prefix is in
	 * this list are watched — useful when one tracker account spans multiple
	 * workspaces (e.g. watch STA-* but not WAB-*). Matching is case-insensitive.
	 * Omit (or use an empty array) to watch every prefix — identical to legacy
	 * behavior.
	 */
	key_prefixes?: string[];
	/**
	 * Most workspaces this watchlist may have open at once, counting ones it
	 * spawned that are still registered or still spawning. Closing one frees
	 * its slot; a status change does not. Omit for no limit.
	 */
	max_workspaces?: number;
}

export interface TerminalConfig {
	app?: string; // "auto" (default), "iTerm", "Ghostty", or any app name
}

/** How each space is drawn in the TUI list. */
export type ListLayout = 'single_line' | 'two_line';

export interface ListViewConfig {
	layout?: ListLayout;
	/** Groups the rail by issue status. Absent keeps the flat list. */
	group_by?: 'status';
	/** Groups after Agents, in rail order. Absent means `DEFAULT_RAIL_GROUPS`. */
	groups?: RailGroupConfig[];
}

/**
 * Starting pane widths for the 3-column layout, as columns or a percentage
 * string such as `"25%"`. A width the user drags by hand replaces these for
 * the rest of the session.
 */
export interface PaneLayoutConfig {
	rail_width?: PaneWidth;
	claude_width?: PaneWidth;
	companion_width?: PaneWidth;
}

export interface Profile {
	keywords?: string[];
	/**
	 * Issue tracker projects that map to this profile (case-insensitive match).
	 * Linear: project names. Jira: project names or keys — an issue's project
	 * key ("KAN") matches just like its display name (STA-1649).
	 */
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
	/**
	 * Agent profile to run in the agent pane for spaces matched to this profile —
	 * a reference into the top-level `agent_profiles:` map. Falls back to the
	 * top-level `agent_profile`, then the built-in `claude`. An empty string clears an inherited
	 * reference back to claude (same empty-string-is-meaningful convention as
	 * `companion_command`).
	 */
	agent_profile?: string;
	/**
	 * Initial prompt sent to the agent on first launch (positional argument,
	 * agent-agnostic). Overrides the top-level `initialization_command`.
	 */
	initialization_command?: string;
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
	/**
	 * Command run in the companion pane for spaces matched to this profile.
	 * Overrides the top-level `companion_command`. Lets a per-project profile
	 * launch something project-specific (e.g. a dev server) instead of the git
	 * UI. An empty string means "run nothing — leave a plain shell". When unset,
	 * falls back to the top-level `companion_command`, then to the built-in
	 * default (`gitui`).
	 */
	companion_command?: string;
	/**
	 * Companion splits started with this profile's spaces. Replaces the
	 * top-level `companion_splits`.
	 */
	companion_splits?: CompanionSplitConfig[];
	/**
	 * Command the `d` key runs for spaces matched to this profile. Overrides the
	 * top-level `ide_command`. An empty string means "do nothing", which is how
	 * a profile opts out of the key. When unset, falls back to the top-level
	 * `ide_command`, then to the built-in default (Cursor).
	 */
	ide_command?: string;
	/**
	 * Per-profile issue watchlist, polled in *addition* to the top-level
	 * `issue_watchlist` (not instead of it). Lets a single profile watch a
	 * different set of statuses/labels than the global watchlist — e.g. a
	 * personal project that should spawn workspaces on a bespoke
	 * "For Pappardelle" status while the top-level watchlist keeps watching
	 * "To Do" across every project.
	 *
	 * Auto-scoped to the profile's team: when this watchlist omits
	 * `key_prefixes` but the profile (or the global config) has a `team_prefix`,
	 * that prefix becomes the key-prefix filter so the profile watchlist only
	 * pulls in its own team's issues. An explicit `key_prefixes` here wins; if
	 * no `team_prefix` is configured anywhere, the watchlist matches every
	 * prefix (same as the top-level watchlist). Workspaces it spawns are forced
	 * to this profile (idow --profile <name>) so they get the right emoji and
	 * profile-specific setup.
	 */
	issue_watchlist?: IssueWatchlistConfig;
}

export interface CompanionSplitConfig {
	name: string;
	command: string;
	/** Which way it is split off the companion's main pane. Defaults to down. */
	split?: SplitDirection;
	/** Cells or a percentage of the companion column, along the split. */
	size?: PaneWidth;
}

export type ResolvedCompanionSplit = CompanionSplitConfig & {
	split: SplitDirection;
};

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
	/**
	 * Named agent profiles for the agent pane. A built-in `claude` agent profile
	 * always exists; defining `agent_profiles.claude` shadows it.
	 */
	agent_profiles?: Record<string, AgentProfileConfig>;
	/** Default agent profile for all profiles — a name from `agent_profiles:` (or `claude`). */
	agent_profile?: string;
	/**
	 * Initial prompt sent to the agent on first launch (positional argument,
	 * agent-agnostic). Replaces the deprecated `claude.initialization_command`,
	 * which is still read as a fallback.
	 */
	initialization_command?: string;
	/** Poll the issue tracker for issues assigned to a user with matching statuses. */
	issue_watchlist?: IssueWatchlistConfig;
	/**
	 * When true, remove a space from the ticket rail as soon as the issue
	 * tracker reports its issue as completed or canceled. Runs the same flow
	 * as pressing `d` (pre_workspace_deinit hooks + registry removal + tmux
	 * kill); the on-disk worktree is left untouched. Off by default — legacy
	 * behavior is identical to master when the field is absent or false.
	 */
	auto_remove_when_done?: boolean;
	/**
	 * tmux key (e.g. `M-s`) that jumps to the sous-chef: it selects the main
	 * space and focuses its agent pane from any pane in Pappardelle's window.
	 * `false` turns it off. Absent ⇒ DEFAULT_SOUS_CHEF_KEY.
	 */
	sous_chef_key?: string | false;
	/**
	 * When true, an agent session in the repo but outside any space (the
	 * main checkout's) is told it coordinates the other spaces. Off by default.
	 */
	sous_chef?: boolean;
	/**
	 * When true, agents in the repo get the pappardelle MCP server's tools and
	 * instructions, and the companion rules at launch. Off by default.
	 */
	workspace_aware_agents?: boolean;
	/**
	 * Opt-in features that are not yet the default. Read from the home config
	 * only: the state database is shared by every repo, so a per-repo value
	 * would split writers between it and the files.
	 */
	experimental?: {sqliteState?: boolean};
	/**
	 * Optional per-status color overrides for the ticket rail, keyed by issue
	 * status name (case-insensitive, surrounding space ignored). A listed status
	 * is painted with this color instead of the color the tracker reports, which
	 * lets a Jira workflow tell "In Progress" and "In Review" apart even though
	 * Jira gives them the same color.
	 *
	 * Values are hex (`#rgb` or `#rrggbb`) or an ANSI color name (`cyan`,
	 * `redBright`, ...). Absent or empty ⇒ the rail uses tracker colors only,
	 * identical to master. The main-worktree row is not affected; it keeps
	 * deriving its color from the tracker's "In Progress" and "Done" colors.
	 */
	state_colors?: Record<string, string>;
	/**
	 * Command launched in the pane beside Claude (the pane that historically ran
	 * lazygit). Defaults to `gitui`. Accepts any shell command — a different git
	 * UI, a dev server, a log tailer, etc. Set to an empty string to leave a
	 * plain shell. A profile's own `companion_command` overrides this value.
	 *
	 * Absent ⇒ `gitui` (the post-STA-1464 default). The pre-STA-1464 behavior of
	 * lazygit is restorable with `companion_command: lazygit`.
	 */
	companion_command?: string;
	/**
	 * Panes started beside the companion when a space first shows in the TUI,
	 * each in a framed pane of its own. One the user closes stays closed. A
	 * profile's own `companion_splits` replaces this list.
	 */
	companion_splits?: CompanionSplitConfig[];
	/**
	 * Command the `d` key runs to open an editor on the selected worktree.
	 * Defaults to Cursor. A profile's own `ide_command` overrides this value,
	 * and an empty string disables the key.
	 */
	ide_command?: string;
	/** Commands to run after git worktree is created. Same format as profile commands. */
	post_workspace_init?: CommandConfig[];
	/** @deprecated Use post_workspace_init instead. Accepted for backwards compat. */
	post_worktree_init?: CommandConfig[];
	/** Commands to run before workspace deletion. If any fails, deletion is aborted. */
	pre_workspace_deinit?: CommandConfig[];
	terminal?: TerminalConfig;
	/** How each space is drawn in the TUI list. Defaults per tracker. */
	list_view?: ListViewConfig;
	layout?: PaneLayoutConfig;
	hooks?: HooksConfig;
	keybindings?: KeybindingConfig[];
	profiles: Record<string, Profile>;
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Get the root of the working tree we are standing in. Inside a linked
 * worktree that is the worktree itself, not the main checkout — use
 * `getMainRepoRoot` when you specifically need the latter.
 */
let repoRootCache: string | undefined;

export function getRepoRoot(): string {
	if (repoRootCache !== undefined) return repoRootCache;

	try {
		// The TUI asks for the common directory right after the root, so one git
		// process answers both.
		const [root, commonDir] = execFileSync(
			'git',
			[
				'rev-parse',
				'--show-toplevel',
				'--path-format=absolute',
				'--git-common-dir',
			],
			{encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']},
		)
			.trim()
			.split('\n');
		if (!root) throw new Error('git reported no working tree');
		repoRootCache = root;
		gitCommonDirCache ??= commonDir || undefined;
		return repoRootCache;
	} catch {
		throw new NotInGitRepoError();
	}
}

let gitCommonDirCache: string | undefined;

/**
 * The main repo's `.git` directory, even from inside a worktree. It can be
 * read from a bare repository, where there is no working tree to report.
 */
function getGitCommonDir(): string {
	gitCommonDirCache ??= execFileSync(
		'git',
		['rev-parse', '--path-format=absolute', '--git-common-dir'],
		{encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']},
	).trim();
	return gitCommonDirCache;
}

let mainRepoRootCache: string | undefined;

export function getMainRepoRoot(): string {
	if (mainRepoRootCache !== undefined) return mainRepoRootCache;
	mainRepoRootCache = resolveMainRepoRoot();
	return mainRepoRootCache;
}

function resolveMainRepoRoot(): string {
	// Set by whoever created this workspace, so a worktree session is told its
	// main checkout instead of forking git to work it out again.
	const injected = process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	if (injected) return injected;

	try {
		const commonDir = getGitCommonDir();
		if (commonDir) return path.dirname(commonDir.replace(/\/+$/, ''));
	} catch {
		// Fall through to the worktree root
	}

	return getRepoRoot();
}

/**
 * Working tree first, main checkout second, resolved per file. A committed
 * `.pappardelle.yml` is checked out into the worktree and found there; one kept
 * out of git exists only in the main checkout. `.pappardelle.local.yml` is
 * gitignored but copied into each worktree by workspace setup, so the worktree's
 * copy wins. Mirrors `find_repo_config` in plugins/pappardelle/hooks/tracker_config.py.
 */
export function findRepoConfig(filename: string): string | undefined {
	const inWorkingTree = path.join(getRepoRoot(), filename);
	if (fs.existsSync(inWorkingTree)) return inWorkingTree;

	const inMainCheckout = path.join(getMainRepoRoot(), filename);
	if (fs.existsSync(inMainCheckout)) return inMainCheckout;

	return undefined;
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
		cachedRepoName = repoNameFromGitCommonDir(getGitCommonDir());
		return cachedRepoName;
	} catch {
		throw new NotInGitRepoError();
	}
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
 * Merge config layers with proper override semantics, lowest priority first
 * (home → project → local); a null layer adds nothing.
 *
 * Uses deep merge for most fields. Keybindings use the smart
 * add/override/disable merge logic from `mergeKeybindings`.
 */
export function mergeConfigLayers(
	allLayers: Array<Record<string, unknown> | null>,
): Record<string, unknown> {
	const layers = allLayers.filter(
		(l): l is Record<string, unknown> => l !== null,
	);
	if (layers.length === 0) {
		return {};
	}

	// Start with the first layer, then merge each subsequent one
	let result: Record<string, unknown> = {...layers[0]!};
	for (let i = 1; i < layers.length; i++) {
		const layer = layers[i]!;

		// Extract keybindings before deep merge so we can smart-merge them
		const baseKb = result['keybindings'];
		const layerKb = layer['keybindings'];

		result = deepMerge(result, layer);

		// Smart-merge keybindings instead of replacing. Anything else is left for
		// the validator to report.
		if (isKeybindingList(baseKb) && isKeybindingList(layerKb)) {
			result['keybindings'] = mergeKeybindings(baseKb, layerKb);
		}
	}

	return result;
}

function isKeybindingList(value: unknown): value is KeybindingConfig[] {
	return (
		Array.isArray(value) &&
		value.every(binding => binding && typeof binding === 'object')
	);
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
export function loadConfigFromPaths(opts: ConfigPaths): PappardelleConfig {
	const files = readConfigLayers(opts);
	const errors = layerErrors(files);
	if (errors.length > 0) {
		throw new ConfigValidationError(errors);
	}

	const layers = parsedLayers(files);
	if (layers.every(({layer}) => !layer)) {
		throw new ConfigNotFoundError(opts.projectDir ?? '(no project dir)');
	}

	return buildConfigFromLayers(layers);
}

const HOME_CONFIG_LABEL = '~/.pappardelle/.pappardelle.yml';

/** The three config files, lowest priority first; `path` is unset for a missing file. */
export function configLayerFiles({
	homeConfigDir,
	projectDir,
	fallbackProjectDir,
}: ConfigPaths): Array<{label: string; path: string | undefined}> {
	const resolveProjectFile = (filename: string): string | undefined => {
		if (projectDir) {
			const candidate = path.join(projectDir, filename);
			if (fs.existsSync(candidate)) return candidate;
		}

		const fallbackDir = fallbackProjectDir?.();
		if (fallbackDir) {
			const candidate = path.join(fallbackDir, filename);
			if (fs.existsSync(candidate)) return candidate;
		}

		return undefined;
	};

	const homePath = homeConfigDir
		? path.join(homeConfigDir, '.pappardelle.yml')
		: undefined;
	return [
		{
			label: HOME_CONFIG_LABEL,
			path: homePath && fs.existsSync(homePath) ? homePath : undefined,
		},
		{label: '.pappardelle.yml', path: resolveProjectFile('.pappardelle.yml')},
		{
			label: '.pappardelle.local.yml',
			path: resolveProjectFile('.pappardelle.local.yml'),
		},
	];
}

function sqliteStateOf(layer: Record<string, unknown> | null): unknown {
	const experimental = layer?.['experimental'];
	return experimental && typeof experimental === 'object'
		? (experimental as Record<string, unknown>)['sqliteState']
		: undefined;
}

/**
 * Whether the home config turns on experimental.sqliteState. Only that file
 * is read, so a project config that fails validation cannot change where
 * state is kept.
 */
export function readHomeSqliteState(
	homeConfigDir = getDefaultHomeConfigDir(),
): boolean {
	const file = path.join(homeConfigDir, '.pappardelle.yml');
	try {
		const content = fs.readFileSync(file, 'utf8');
		return sqliteStateOf(parseConfigLayer(HOME_CONFIG_LABEL, content)) === true;
	} catch (error) {
		// A home config that cannot be read would otherwise move all state
		// back to the files without a word.
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn(
				`Could not read experimental.sqliteState from ${file}, so state is kept in files`,
				error instanceof Error ? error : undefined,
			);
		}

		return false;
	}
}

/** Parse one config file's text; null when the file holds no document. */
export function parseConfigLayer(
	label: string,
	content: string,
): Record<string, unknown> | null {
	const document = parseDocument(content, {merge: true});
	// Warnings such as an unknown tag are mistakes in the file, and `yaml`
	// would otherwise drop the tag and keep the value.
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem) {
		throw new ConfigValidationError([`${label}: ${problem.message}`]);
	}

	let parsed: unknown;
	try {
		// `yaml` hands back one object for an anchor and its aliases, but in
		// YAML an alias is a copy: rewriting one place must leave the others.
		parsed = unshareAliases(document.toJS());
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new ConfigValidationError([`${label}: ${msg}`]);
	}
	if (parsed === null || parsed === undefined) return null;
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ConfigValidationError([`${label}: the top level must be a map`]);
	}

	return parsed as Record<string, unknown>;
}

function unshareAliases(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => unshareAliases(item));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, unshareAliases(item)]),
		);
	}

	return value;
}

function misplacedSqliteStateErrors(
	layers: Array<{label: string; layer: Record<string, unknown> | null}>,
): string[] {
	return layers
		.slice(1)
		.filter(({layer}) => sqliteStateOf(layer) !== undefined)
		.map(
			({label}) =>
				`${label}: experimental.sqliteState can only be set in ${HOME_CONFIG_LABEL}, because every repo shares one state database`,
		);
}

/**
 * Merge and validate parsed layers (lowest priority first, as
 * configLayerFiles lists them). The layers are modified in place.
 */
export function buildConfigFromLayers(
	layers: Array<{label: string; layer: Record<string, unknown> | null}>,
): PappardelleConfig {
	// The two initialization_command spellings are only ambiguous within one
	// file. Across layers, whichever spelling a file uses, the more specific
	// layer must win, so each layer is rewritten to the new spelling before the
	// merge and ordinary layer precedence applies. The conflict check therefore
	// runs per layer too: a home config still on the deprecated spelling must
	// not brick a project that has migrated.
	const conflictErrors = layers.flatMap(({layer, label}) =>
		layer ? initializationCommandConflictErrors(layer, label) : [],
	);
	if (conflictErrors.length > 0) {
		throw new ConfigValidationError(conflictErrors);
	}

	const misplacedFlags = misplacedSqliteStateErrors(layers);
	if (misplacedFlags.length > 0) {
		throw new ConfigValidationError(misplacedFlags);
	}

	const agentProfiles = mergedAgentProfiles(layers.map(({layer}) => layer));
	for (const {layer, label} of layers) {
		if (layer) {
			warnDeprecatedClaudeFields(layer, label, agentProfiles);
			renameDeprecatedInitializationCommand(layer);
		}
	}

	const merged = mergeConfigLayers(layers.map(({layer}) => layer));
	const errors = configErrors(merged);
	if (errors.length > 0) {
		throw new ConfigValidationError(labelErrorsByLayer(errors, layers));
	}

	return merged as unknown as PappardelleConfig;
}

/**
 * Name the file an error comes from: the one file whose absence from the
 * merge makes the error go away, when that file's value is also the one the
 * merged config holds at the error's key, or at the nearest key around it
 * when the key itself is missing (a jira tracker with no base_url). An error
 * that no single file explains, like a duplicate spread over two files, one
 * whose wording depends on another file (a keybinding's index), or one that
 * only goes away because a file holds what the key is checked against (the
 * profiles a default_profile names), keeps no file name. A single-file
 * config's errors are already about that file.
 */
function labelErrorsByLayer(
	errors: string[],
	layers: Array<{label: string; layer: Record<string, unknown> | null}>,
): string[] {
	const files = layers.filter(({layer}) => layer);
	if (files.length < 2) return errors;
	// configErrors fills in defaults, so each merge gets its own copies.
	const mergeCopies = (without?: string) =>
		mergeConfigLayers(
			layers.map(other =>
				other.label === without || !other.layer
					? null
					: structuredClone(other.layer),
			),
		);
	const merged = mergeCopies();
	const errorsWithout = files.map(({label}) => ({
		label,
		errors: new Set(configErrors(mergeCopies(label))),
	}));
	return errors.map(error => {
		const sources = errorsWithout.filter(({errors}) => !errors.has(error));
		// The merged keybindings list is re-indexed, so its indexes name no file's entries.
		if (sources.length !== 1 || error.startsWith('keybindings[')) return error;
		const keys = keyPathIn(merged, error.split(': ', 1)[0]!);
		if (keys.length === 0) return error;
		const winner = files.findLast(({layer}) => hasKeyPath(layer, keys));
		return winner?.label === sources[0]!.label
			? `${winner.label}: ${error}`
			: error;
	});
}

/**
 * The keys of `config` an error's path runs through, as far as they exist.
 * The path is written with '.' and [n], but names can hold either (an agent
 * profile called gpt-4.1), so each level takes its longest key that the rest
 * of the path starts with.
 */
function keyPathIn(config: unknown, errorPath: string): string[] {
	const keys: string[] = [];
	let node = config;
	let rest = errorPath;
	while (rest && node && typeof node === 'object') {
		const key = leadingKey(node, rest);
		if (key === undefined || !Object.hasOwn(node, key)) break;
		keys.push(key);
		rest = rest.slice(Array.isArray(node) ? `[${key}]`.length : key.length);
		if (rest.startsWith('.')) rest = rest.slice(1);
		node = (node as Record<string, unknown>)[key];
	}

	return keys;
}

function leadingKey(node: object, errorPath: string): string | undefined {
	if (Array.isArray(node)) return /^\[(\d+)]/.exec(errorPath)?.[1];
	return Object.keys(node)
		.filter(
			name =>
				errorPath.startsWith(name) &&
				['', '.', '['].includes(errorPath.charAt(name.length)),
		)
		.sort((a, b) => b.length - a.length)[0];
}

function hasKeyPath(value: unknown, keys: string[]): boolean {
	let node = value;
	for (const key of keys) {
		if (!node || typeof node !== 'object' || !Object.hasOwn(node, key))
			return false;
		node = (node as Record<string, unknown>)[key];
	}

	return true;
}

/** The agent_profiles of raw layers, merged as the config merges them. */
export function mergedAgentProfiles(
	layers: Array<Record<string, unknown> | null | undefined>,
): Record<string, unknown> {
	let merged: Record<string, unknown> = {};
	for (const layer of layers) {
		const profiles = layer?.['agent_profiles'];
		if (profiles && typeof profiles === 'object') {
			merged = deepMerge(merged, profiles as Record<string, unknown>);
		}
	}

	return merged;
}

/**
 * Load the .pappardelle.yml config from the repository root.
 * Supports 3-layer merge: home (~/.pappardelle/.pappardelle.yml) →
 * project (.pappardelle.yml) → local (.pappardelle.local.yml).
 */
export function loadConfig(): PappardelleConfig {
	return loadConfigFromPaths(defaultConfigPaths());
}

export type ConfigLoad =
	| {kind: 'missing'}
	| {kind: 'valid'; config: PappardelleConfig}
	| {kind: 'invalid'; errors: string[]};

/**
 * The config, or why there is none. Only a missing config falls back to the
 * built-in defaults: an invalid one would replace the settings the user wrote.
 */
export function readConfig(paths?: ConfigPaths): ConfigLoad {
	try {
		return {
			kind: 'valid',
			config: loadConfigFromPaths(paths ?? defaultConfigPaths()),
		};
	} catch (error) {
		if (error instanceof ConfigNotFoundError) return {kind: 'missing'};
		if (error instanceof NotInGitRepoError) return {kind: 'missing'};
		if (error instanceof ConfigValidationError)
			return {kind: 'invalid', errors: error.errors};
		return {
			kind: 'invalid',
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
}

export type ConfigPaths = {
	homeConfigDir?: string;
	projectDir?: string;
	fallbackProjectDir?: () => string | undefined;
};

export function defaultConfigPaths(): ConfigPaths {
	return {
		homeConfigDir: getDefaultHomeConfigDir(),
		projectDir: getRepoRoot(),
		fallbackProjectDir: getMainRepoRoot,
	};
}

/**
 * One config file as read. A read file's layer is null when it holds no
 * document; an invalid one exists but can't be read or parsed, or its top
 * level isn't a map.
 */
export type ConfigLayerFile =
	| {kind: 'missing'; label: string}
	| {
			kind: 'read';
			label: string;
			path: string;
			content: string;
			layer: Record<string, unknown> | null;
	  }
	| {kind: 'invalid'; label: string; path: string; errors: string[]};

/**
 * The config files, always home, project and local in that order, labeled
 * the way config errors name them. An invalid file is reported rather than
 * thrown, so callers that only need part of the config keep working while
 * another section is broken.
 */
export function readConfigLayers(paths: ConfigPaths): ConfigLayerFile[] {
	return configLayerFiles(paths).map(({label, path: filePath}) => {
		if (!filePath) return {kind: 'missing', label};
		try {
			const content = fs.readFileSync(filePath, 'utf8');
			return {
				kind: 'read',
				label,
				path: filePath,
				content,
				layer: parseConfigLayer(label, content),
			};
		} catch (error) {
			return {
				kind: 'invalid',
				label,
				path: filePath,
				errors:
					error instanceof ConfigValidationError
						? error.errors
						: [
								`${label}: ${error instanceof Error ? error.message : String(error)}`,
							],
			};
		}
	});
}

/** What a file adds to the merge: nothing unless it was read and holds a document. */
export function layerOf(file: ConfigLayerFile): Record<string, unknown> | null {
	switch (file.kind) {
		case 'read': {
			return file.layer;
		}

		case 'missing':
		case 'invalid': {
			return null;
		}
	}
}

/** Why each invalid file was left out of the merge. */
export function layerErrors(files: ConfigLayerFile[]): string[] {
	return files.flatMap(file => (file.kind === 'invalid' ? file.errors : []));
}

export function parsedLayers(
	files: ConfigLayerFile[],
): Array<{label: string; layer: Record<string, unknown> | null}> {
	return files.map(file => ({label: file.label, layer: layerOf(file)}));
}

/**
 * Reject `experimental.sqliteState` in project or local config without
 * validating unrelated config sections, so CLI commands and the TUI still run
 * while another section is being edited.
 */
export function validateHomeOnlySqliteState(
	opts: ConfigPaths = defaultConfigPaths(),
): void {
	const errors = misplacedSqliteStateErrors(
		parsedLayers(readConfigLayers(opts)),
	);
	if (errors.length > 0) {
		throw new ConfigValidationError(errors);
	}
}

/**
 * Load just the provider configs (issue_tracker, vcs_host) from the merged
 * home -> project -> local layers, without validating the rest of the config
 * so providers can be initialized even when unrelated sections (e.g.
 * profiles) have errors. A layer that fails to parse is skipped for the same
 * reason. Reads the same files as loadConfigFromPaths(); the defaults are
 * what loadConfig() uses.
 */
export function loadProviderConfigs(opts?: ConfigPaths): {
	issue_tracker?: IssueTrackerConfig;
	vcs_host?: VcsHostConfig;
	/** Why a layer that exists was skipped; its providers are missing from the result. */
	layerErrors: string[];
} {
	const files = readConfigLayers(opts ?? defaultConfigPaths());
	const merged = mergeConfigLayers(files.map(file => layerOf(file)));
	return {
		issue_tracker: merged['issue_tracker'] as IssueTrackerConfig | undefined,
		vcs_host: merged['vcs_host'] as VcsHostConfig | undefined,
		layerErrors: layerErrors(files),
	};
}

/**
 * The config files that define each agent profile, highest priority first so
 * the picker's truncated source column keeps the file whose values win. A
 * profile can be spread over several layers, e.g. a command in the home config
 * with a model overridden in `.pappardelle.local.yml`.
 */
export function loadAgentProfileSources(
	opts?: ConfigPaths,
): Record<string, string[]> {
	const sources: Record<string, string[]> = {};
	for (const file of readConfigLayers(opts ?? defaultConfigPaths())) {
		const agentProfiles = layerOf(file)?.['agent_profiles'];
		if (!agentProfiles || typeof agentProfiles !== 'object') continue;
		for (const name of Object.keys(agentProfiles)) {
			(sources[name] ??= []).unshift(file.label);
		}
	}

	return sources;
}

/**
 * Check if a .pappardelle.yml exists at the repo root
 */
export function configExists(): boolean {
	try {
		return findRepoConfig('.pappardelle.yml') !== undefined;
	} catch {
		return false;
	}
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
	/** The working tree pappardelle is running in. */
	REPO_ROOT: string;
	MAIN_REPO_ROOT: string;
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
 * word — or any hyphen-split sub-token of an input word — starts with it.
 * For example, keyword "track" matches "tracking", keyword "SHOP-" matches
 * "SHOP-313", and keyword "music" matches "fix-music-bug" (sub-token).
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

	// Hyphen-split sub-tokens: lets a keyword match when it's buried inside a
	// hyphen-joined word like "fix-music-bug" → "music". Original `words` is
	// preserved so trailing-hyphen keywords (e.g. "SHOP-") still match the
	// whole word "shop-313" and still reject bare "shop".
	const subTokens = [
		...new Set(
			words.flatMap(w =>
				w.includes('-') ? w.split('-').filter(t => t.length > 0) : [],
			),
		),
	];

	const matches: ProfileMatch[] = [];

	for (const [name, profile] of Object.entries(config.profiles)) {
		const matchedKeywords: string[] = [];

		for (const keyword of profile.keywords ?? []) {
			const kwLower = keyword.toLowerCase();
			// Split keyword on whitespace to detect multi-word keywords
			const kwParts = kwLower.split(/\s+/).filter(p => p.length > 0);

			if (kwParts.length === 0) continue;

			if (kwParts.length === 1) {
				// Prefix match: any input word — or hyphen-split sub-token — starting
				// with the keyword matches.
				if (
					words.some(w => w.startsWith(kwLower)) ||
					subTokens.some(t => t.startsWith(kwLower))
				) {
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
 * Find a profile that matches the given issue tracker project.
 * Uses case-insensitive exact matching against each profile's `tracker_projects` list.
 * Returns the first matching profile, or null if no profile matches.
 *
 * Jira issues carry a project key (e.g. "KAN") alongside the display name
 * ("Pappardelle Testing"), and users naturally write either into
 * `tracker_projects` — so when a key is supplied, an entry matching it counts
 * too (STA-1649). Linear callers pass no key, keeping their behavior
 * byte-identical to name-only matching.
 */
export function matchProfileByProject(
	config: PappardelleConfig,
	projectName: string,
	projectKey?: string,
): {name: string; profile: Profile} | null {
	const candidates: string[] = [];
	for (const candidate of [projectName, projectKey]) {
		if (candidate) candidates.push(candidate.toLowerCase());
	}

	if (candidates.length === 0) return null;

	for (const [name, profile] of Object.entries(config.profiles)) {
		if (
			profile.tracker_projects?.some(tp =>
				candidates.includes(tp.toLowerCase()),
			)
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

/**
 * The default issue-tracker project for newly-created issues under a profile.
 *
 * When `idow` creates a new issue (no key supplied), `provider-helpers.sh`
 * resolves this name to a Linear project UUID and passes it to
 * `linctl issue create --project <uuid>`. Returns `undefined` when the
 * profile has no `tracker_projects` (or an empty array), in which case the
 * issue is created with no project assigned (pre-STA-959 behavior).
 *
 * Centralizing the "first entry wins" rule here keeps the TS-side and the
 * bash-side `yq -r '.profiles.<p>.tracker_projects[0]'` lookup in lockstep.
 */
export function getProfileDefaultProject(profile: Profile): string | undefined {
	const first = profile.tracker_projects?.[0];
	return first === undefined || first === '' ? undefined : first;
}

const beadsIssuePrefixCache = new Map<string, string | undefined>();

export function readBeadsIssuePrefix(
	repoRoot?: string,
	readDatabasePrefix: (root: string) => string | undefined = readBdIssuePrefix,
): string | undefined {
	// getMainRepoRoot throws outside a git repo; this function's contract is to
	// return undefined rather than propagate, so it has to resolve inside the try.
	let root: string;
	try {
		root = repoRoot ?? getMainRepoRoot();
	} catch {
		return undefined;
	}

	if (beadsIssuePrefixCache.has(root)) {
		return beadsIssuePrefixCache.get(root);
	}
	const result =
		resolveBeadsIssuePrefix(root) ??
		(fs.existsSync(path.join(root, '.beads'))
			? readDatabasePrefix(root)
			: undefined);
	beadsIssuePrefixCache.set(root, result);
	return result;
}

export function clearBeadsIssuePrefixCache(): void {
	beadsIssuePrefixCache.clear();
}

function resolveBeadsIssuePrefix(root: string): string | undefined {
	try {
		const raw = fs.readFileSync(
			path.join(root, '.beads', 'config.yaml'),
			'utf-8',
		);
		const parsed = parseYaml(raw) as Record<string, unknown> | undefined;
		const prefix = parsed?.['issue-prefix'];
		return typeof prefix === 'string' && prefix.trim()
			? prefix.trim()
			: undefined;
	} catch {
		return undefined;
	}
}

export function parseBdIssuePrefix(output: string): string | undefined {
	const [payload] = unwrapBeadsJson(output);
	const value = payload?.['value'];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * `bd init --prefix` (bd 1.3+) keeps the prefix in its database and leaves
 * `issue-prefix` commented out in config.yaml.
 */
function readBdIssuePrefix(root: string): string | undefined {
	try {
		const output = execFileSync(
			'bd',
			['config', 'get', 'issue_prefix', '--json'],
			{
				cwd: root,
				encoding: 'utf-8',
				env: {...process.env, BD_JSON_ENVELOPE: '1'},
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 5000,
			},
		);
		return parseBdIssuePrefix(output);
	} catch (error) {
		logger.debug(
			`bd config get issue_prefix failed in ${root}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

/**
 * Issue keys the new-session prompt offers as examples. Beads ids carry a hash
 * rather than a number, so a `TEAM-123` example would mislead there.
 */
export function exampleIssueKeys(
	config: PappardelleConfig,
	readPrefix: () => string | undefined = readBeadsIssuePrefix,
): string[] {
	if (config.issue_tracker?.provider === 'beads') {
		const [prefix = 'bd'] = getBeadsPrefixes(config, readPrefix());
		return [`${prefix}-a1b2`];
	}

	return [`${getTeamPrefix(config)}-123`, '123'];
}

export function getBeadsPrefixes(
	config: PappardelleConfig,
	beadsConfigPrefix?: string,
): string[] {
	const prefixes = new Set<string>();
	const add = (value: string | undefined) => {
		const trimmed = value?.trim().toLowerCase();
		if (trimmed) prefixes.add(trimmed);
	};

	add(beadsConfigPrefix);
	add(config.team_prefix);
	for (const profile of Object.values(config.profiles ?? {})) {
		add(profile.team_prefix);
		for (const project of profile.tracker_projects ?? []) add(project);
	}

	return [...prefixes];
}

export type ProfilePrefixMatch = {
	name: string;
	profile: Profile;
	explicit: boolean;
};

export function matchProfilesByKeyPrefix(
	config: PappardelleConfig,
	prefix: string,
): ProfilePrefixMatch[] {
	const wanted = prefix.trim().toUpperCase();
	if (!wanted) return [];

	const globalPrefix = getTeamPrefix(config);
	const explicit: ProfilePrefixMatch[] = [];
	const inherited: ProfilePrefixMatch[] = [];

	for (const [name, profile] of Object.entries(config.profiles)) {
		const ownPrefix = profile.team_prefix?.toUpperCase();
		const projectKeyMatch = profile.tracker_projects?.some(
			tp => tp.trim().toUpperCase() === wanted,
		);
		const watchedPrefixMatch = profile.issue_watchlist?.key_prefixes?.some(
			kp => kp.trim().toUpperCase() === wanted,
		);

		if (ownPrefix === wanted || projectKeyMatch || watchedPrefixMatch) {
			explicit.push({name, profile, explicit: true});
			continue;
		}

		if (ownPrefix === undefined && globalPrefix === wanted) {
			inherited.push({name, profile, explicit: false});
		}
	}

	return [...explicit, ...inherited];
}

function beadsInputKeyPrefix(
	config: PappardelleConfig,
	input: string,
): string | null {
	if (config.issue_tracker?.provider !== 'beads') return null;

	const trimmed = input.trim();
	const prefixes = getBeadsPrefixes(config, readBeadsIssuePrefix());
	if (!isBeadsIssueKey(trimmed, prefixes)) return null;
	return issueKeyPrefix(trimmed);
}

export function inputKeyPrefix(
	config: PappardelleConfig,
	input: string,
): string | null {
	return issueKeyTeamPrefix(input) ?? beadsInputKeyPrefix(config, input);
}

/**
 * Profiles claiming the prefix of whatever issue identifier `input` names.
 * Empty for prose and for bare numbers, which have no prefix of their own.
 */
export function matchProfilesByInputKeyPrefix(
	config: PappardelleConfig,
	input: string,
): ProfilePrefixMatch[] {
	const prefix = inputKeyPrefix(config, input);
	if (!prefix) return [];
	return matchProfilesByKeyPrefix(config, prefix);
}

// Issue-key patterns used to short-circuit keyword matching and return the default profile.
// Case-insensitive like isLinearIssueKey and normalizeIssueIdentifier: a
// lowercase key reaches the tracker as the same issue, so it has to reach the
// same profile decision too.
const DETERMINE_PROFILE_ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/i;
const DETERMINE_PROFILE_ISSUE_NUMBER = /^\d+$/;
const DETERMINE_PROFILE_LINEAR_URL =
	/^https:\/\/linear\.app\/.+\/issue\/[A-Z][A-Z0-9]*-\d+/i;

/**
 * Label shown in the TUI when profile selection is deferred to idow's
 * tracker_projects lookup (issue-key / bare-number / Linear-URL inputs).
 */
export const DEFERRED_PROFILE_DISPLAY_NAME = 'Determined by issue project';

export type ProfileSelection =
	| {
			kind: 'deferred';
			displayName: string;
			canPick: boolean;
	  }
	| {
			kind: 'resolved';
			name: string;
			displayName: string;
			isDefault: boolean;
			matchedKeywords: string[];
			enforced: boolean;
			/**
			 * Ticket-rail emoji slot for the resolved profile, with the rail's
			 * three-state semantics (`undefined` = nobody configured one, `''` =
			 * slot reserved but blank). Carried here so the TUI's typing-stage hint
			 * shows the same glyph the profile picker will show a keystroke later.
			 */
			emoji: string | undefined;
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
 *    idow picks the profile from the fetched issue's tracker project, so
 *    that is what the caller gets by default. `canPick` says whether any
 *    profile claims the key's prefix, in which case the caller should still
 *    offer the picker and honor an explicit override
 *  - `{kind: 'resolved'}` otherwise (keyword match or default fallback)
 */
export function determineProfileForInput(
	config: PappardelleConfig,
	input: string,
): ProfileSelection | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const isBeadsKey = beadsInputKeyPrefix(config, trimmed) !== null;

	if (
		DETERMINE_PROFILE_ISSUE_KEY.test(trimmed) ||
		DETERMINE_PROFILE_ISSUE_NUMBER.test(trimmed) ||
		DETERMINE_PROFILE_LINEAR_URL.test(trimmed) ||
		isBeadsKey
	) {
		return {
			kind: 'deferred',
			displayName: DEFERRED_PROFILE_DISPLAY_NAME,
			canPick:
				isBeadsKey || matchProfilesByInputKeyPrefix(config, trimmed).length > 0,
		};
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
			emoji: getProfileEmoji(def.profile, config),
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
		emoji: getProfileEmoji(best.profile, config),
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

export const DEFAULT_TEAM_PREFIX = 'STA';

/**
 * Get the team prefix for issue identifiers (e.g., 'STA' for 'STA-123')
 * Defaults to DEFAULT_TEAM_PREFIX if not configured
 */
export function getTeamPrefix(config: PappardelleConfig): string {
	const prefix = config.team_prefix ?? DEFAULT_TEAM_PREFIX;
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
	const prefix =
		profile.team_prefix ?? config.team_prefix ?? DEFAULT_TEAM_PREFIX;
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
 * Resolve the emoji slot for a pending placeholder row ("Starting new
 * session…", "Opening…", "Watchlist: …").
 *
 * Pending rows have to mirror real rows' slot occupancy or the Claude
 * thinking icon rendered to their right ends up flush left while every
 * other row's icon sits at column 3 — visibly misaligned. Three cases:
 *
 *   - `config` is null (load failed) → undefined; the renderer skips
 *     the slot, matching the rest of the (also slot-less) list.
 *   - `profileName` is set and resolves to a profile → that profile's
 *     emoji chain via `getProfileEmoji`.
 *   - Otherwise → `getProfileEmoji(undefined, config)`, which yields
 *     `default_emoji` when set, `''` (slot reserved blank) when any
 *     other profile has an emoji, or `undefined` when no emoji
 *     machinery exists in the config (off-by-default regression: rows
 *     stay byte-identical to master).
 */
export function resolvePendingProfileEmoji(
	config: PappardelleConfig | null,
	profileName?: string | null,
): string | undefined {
	if (!config) return undefined;
	const profile = profileName ? getProfile(config, profileName) : undefined;
	return getProfileEmoji(profile, config);
}

/**
 * Get the agent initialization command from config (the positional prompt
 * passed on first launch). The top-level `initialization_command` wins; the
 * deprecated `claude.initialization_command` spelling is read as a fallback.
 * Returns the command string (e.g., "/idow") or empty string if not configured.
 */
export function getInitializationCommand(config: PappardelleConfig): string {
	return (
		config.initialization_command ??
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- backwards-compat fallback for the old spelling
		config.claude?.initialization_command ??
		''
	);
}

export const SOUS_CHEF_NAME = 'sous-chef';

/** The user's own instructions for the sous-chef, at the main checkout's root. */
export const SOUS_CHEF_FILE = 'SOUS-CHEF.md';

export type SousChefLaunch = {name: string; prompt?: string};

/** How the TUI launches a space's agent, beyond its agent profile. */
export type AgentLaunch = Partial<SousChefLaunch> & {
	/** Pass the companion rules to the agents that take them at launch. */
	rules: boolean;
};

export function workspaceAwareAgents(
	config: PappardelleConfig | null,
): boolean {
	return config?.workspace_aware_agents === true;
}

/**
 * How the main checkout's agent launches in sous-chef mode: under the
 * coordinator's name, which other agents address with SendMessage, and with
 * the skill as its first prompt for CLIs that accept it, so every launch opens
 * on the board.
 */
export function sousChefLaunch(
	config: PappardelleConfig | null,
	agentProfile?: Pick<
		ResolvedAgentProfile,
		'command' | 'isClaude' | 'promptArgs' | 'skillPrefix'
	>,
): SousChefLaunch | undefined {
	if (config?.sous_chef !== true) return undefined;
	if (agentProfile && !supportsSousChefPrompt(agentProfile)) {
		return {name: SOUS_CHEF_NAME};
	}
	const prefix = agentProfile?.skillPrefix ?? '/';
	return {name: SOUS_CHEF_NAME, prompt: `${prefix}${SOUS_CHEF_NAME}`};
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
 * Pick the profile a launch resolver should read overrides from.
 *
 * `profileName` — the profile persisted in the per-space state file (written
 * by idow at workspace creation) — wins over keyword-matching `issueTitle`:
 * a title with no profile keyword would otherwise silently fall back to
 * top-level values on reattach, recreating the space with a different agent /
 * model than it was created with. A persisted name that no longer exists in
 * the config falls through to title matching.
 */
function selectProfile(
	config: PappardelleConfig,
	issueTitle?: string,
	profileName?: string,
): Profile | undefined {
	if (profileName) {
		const profile = config.profiles[profileName];
		if (profile) {
			return profile;
		}
	}
	if (issueTitle) {
		return matchProfiles(config, issueTitle)[0]?.profile;
	}
	return undefined;
}

/**
 * Resolve one of the pass-through Claude launch flags for a workspace.
 *
 * Resolution order: per-profile value, then top-level value, then `''`. The
 * profile comes from `selectProfile` (persisted name first, then `issueTitle`
 * keyword match, same as `getCompanionCommand`), so a space with neither
 * simply gets the top-level value.
 *
 * The profile layer wins whenever the *key is present*, not merely when it's
 * truthy. That's what makes `model: ""` on a profile mean "ignore the global
 * model, launch with Claude's default" rather than "no opinion", the same
 * empty-string-is-meaningful convention `companion_command` uses.
 *
 * `''` is the universal "don't pass this flag" signal: callers omit the flag
 * entirely rather than passing an empty value through to `claude`.
 */
function resolveClaudeLaunchField(
	config: PappardelleConfig,
	field: LaunchField,
	issueTitle?: string,
	profileName?: string,
): string {
	const profile = selectProfile(config, issueTitle, profileName);
	const profileValue = profile?.claude?.[field];
	if (profileValue !== undefined) {
		return profileValue;
	}
	return config.claude?.[field] ?? '';
}

/**
 * The agent profile's own value wins on key presence (`''` passes no flag).
 * Without one, claude agent profiles fall back to the deprecated `claude:`
 * blocks with their usual profile-over-top-level layering; other CLIs never
 * read them, since those values were written for claude.
 */
function resolveAgentLaunchField(
	config: PappardelleConfig,
	definition: AgentProfileConfig,
	field: LaunchField,
	issueTitle?: string,
	profileName?: string,
): string {
	const own = definition[field];
	if (own !== undefined) {
		return own;
	}
	const isClaude = isClaudeAgentProfile(definition);
	return isClaude
		? resolveClaudeLaunchField(config, field, issueTitle, profileName)
		: '';
}

/**
 * The deprecated `claude.extra_args` for a claude agent profile, profile list
 * over top-level list. Other CLIs never get them, since they are claude flags.
 */
function resolveClaudeExtraArgs(
	config: PappardelleConfig,
	definition: AgentProfileConfig,
	issueTitle?: string,
	profileName?: string,
): string[] {
	if (!isClaudeAgentProfile(definition)) return [];
	return (
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated field's fallback
		selectProfile(config, issueTitle, profileName)?.claude?.extra_args ??
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated field's fallback
		config.claude?.extra_args ??
		[]
	);
}

/**
 * The agent profile every config gets without any `agent_profiles:` section.
 * Defining `agent_profiles.claude` shadows this.
 */
const BUILTIN_CLAUDE_AGENT_PROFILE: AgentProfileConfig = {command: 'claude'};

/**
 * The named agent profile's definition, built-in claude when undefined.
 * Trailing whitespace is trimmed: a YAML block scalar (`args: >`) ends in a
 * newline, which would submit the typed launch line early.
 * resolve-agent-config.sh trims the same way.
 */
function lookupAgentProfile(
	config: PappardelleConfig,
	name: string,
): AgentProfileConfig {
	const definition =
		config.agent_profiles?.[name] ?? BUILTIN_CLAUDE_AGENT_PROFILE;
	return Object.fromEntries(
		Object.entries(definition).map(([key, value]) => [
			key,
			typeof value === 'string' ? value.trimEnd() : value,
		]),
	) as AgentProfileConfig;
}

/**
 * An agent profile resolved for a workspace, ready for command assembly.
 * `resumeArgs === undefined` means "no resume attempt — launch directly".
 */
export interface ResolvedAgentProfile {
	name: string;
	command: string;
	args: string;
	resumeArgs?: string;
	isClaude: boolean;
	/**
	 * Values to launch with. `''` passes no flag, which keeps the launch
	 * byte-identical for configs that never mention model, effort, or mode.
	 */
	model: string;
	effort: string;
	mode: string;
	/** Flag templates for model/effort/mode; undefined means the CLI gets none. */
	modelArgs?: string;
	effortArgs?: string;
	modeArgs?: string;
	promptArgs?: string;
	/** The deprecated `claude.extra_args`, rendered after model/effort/mode. */
	extraArgs: string[];
	skillPrefix: string;
	/** How the agent takes the companion rules at launch; see agentRulesFlags. */
	rulesArgs: string[];
	env: Record<string, string>;
}

/**
 * Apply the claude-gating predicate and built-in defaults to one agent
 * profile. `resume_args: ''` is an explicit "no resume attempt", matching the
 * bash resolvers, where an empty value means launch directly; only an absent
 * field gets the built-in default.
 */
function resolveAgentProfile(
	name: string,
	definition: AgentProfileConfig,
): ResolvedAgentProfile {
	const isClaude = isClaudeAgentProfile(definition);
	const builtin = builtinAgentDefaults(definition);
	const resumeArgs =
		(definition.resume_args ?? builtin.resume_args) || undefined;

	return {
		name,
		command: definition.command,
		args: definition.args ?? '',
		resumeArgs,
		isClaude,
		model: definition.model ?? '',
		effort: definition.effort ?? '',
		mode: definition.mode ?? '',
		modelArgs: definition.model_args ?? builtin.model_args,
		effortArgs: definition.effort_args ?? builtin.effort_args,
		modeArgs: definition.mode_args ?? builtin.mode_args,
		promptArgs: definition.prompt_args ?? builtin.prompt_args,
		extraArgs: [],
		skillPrefix: definition.skill_prefix ?? builtin.skill_prefix ?? '/',
		rulesArgs: builtin.rules_args ?? [],
		env: definition.env ?? {},
	};
}

/**
 * What getAgentProfile returns for a config with no agent profile settings.
 * buildAgentResumeCommand and ensureAgentSession default to it.
 */
export const DEFAULT_RESOLVED_AGENT_PROFILE: ResolvedAgentProfile =
	resolveAgentProfile('claude', BUILTIN_CLAUDE_AGENT_PROFILE);

/**
 * Resolve which agent profile runs in a workspace's agent pane.
 *
 * Name resolution follows the launch-field convention: the matched profile's
 * `agent_profile` → top-level `agent_profile` → `'claude'`, where the profile layer wins on
 * key presence and an explicit `''` clears an inherited reference back to
 * claude. The name is then looked up in `agent_profiles:`, with the built-in claude
 * definition as the fallback — both for the name `claude` when it isn't
 * shadowed and for dangling references (validation rejects those, but config
 * can arrive unvalidated via older layers).
 *
 * Built-in defaults come from scripts/builtin-agents.json (see
 * builtinAgentDefaults); agents without an entry launch directly unless they
 * declare `resume_args`. Mirrored by resolve-agent-config.sh — keep in sync.
 */
export function getAgentProfile(
	config: PappardelleConfig,
	issueTitle?: string,
	profileName?: string,
): ResolvedAgentProfile {
	return getNamedAgentProfile(
		config,
		resolveAgentProfileName(config, issueTitle, profileName),
		issueTitle,
		profileName,
	);
}

/** getAgentProfile for an agent profile chosen by name rather than resolved. */
export function getNamedAgentProfile(
	config: PappardelleConfig,
	name: string,
	issueTitle?: string,
	profileName?: string,
): ResolvedAgentProfile {
	const definition = lookupAgentProfile(config, name);
	return {
		...resolveAgentProfile(name, definition),
		model: resolveAgentLaunchField(
			config,
			definition,
			'model',
			issueTitle,
			profileName,
		),
		effort: resolveAgentLaunchField(
			config,
			definition,
			'effort',
			issueTitle,
			profileName,
		),
		extraArgs: resolveClaudeExtraArgs(
			config,
			definition,
			issueTitle,
			profileName,
		),
	};
}

/**
 * The agent profile a space is running: the one last launched in it (if still
 * defined in config), else the default resolved for its workspace profile.
 */
export function getSpaceAgentProfile(
	config: PappardelleConfig,
	state?: {
		agentProfile?: {name: string};
		issueTitle?: string;
		profile?: string;
	} | null,
): ResolvedAgentProfile {
	const launched = state?.agentProfile?.name;
	const name =
		launched && checkAgentProfile(config, launched).kind === 'known'
			? launched
			: resolveAgentProfileName(config, state?.issueTitle, state?.profile);
	return getNamedAgentProfile(config, name, state?.issueTitle, state?.profile);
}

export function resolveAgentProfileName(
	config: PappardelleConfig,
	issueTitle?: string,
	profileName?: string,
): string {
	let name = config.agent_profile ?? 'claude';
	const profile = selectProfile(config, issueTitle, profileName);
	if (profile?.agent_profile !== undefined) {
		name = profile.agent_profile;
	}
	return name === '' ? 'claude' : name;
}

/**
 * Every agent profile a session can launch with, labeled with the config files
 * that define it (see loadAgentProfileSources). The built-in claude is
 * selectable even in configs that never define `agent_profiles:`.
 */
export function listAgentProfiles(
	config: PappardelleConfig,
	sources: Record<string, string[]>,
): Array<{name: string; source: string}> {
	return agentProfileNames(config).map(name => ({
		name,
		source: sources[name]?.join(' + ') ?? 'built-in',
	}));
}

/** Every agent profile a session can launch with, the built-in claude first. */
export function agentProfileNames(config: PappardelleConfig): string[] {
	const names = Object.keys(config.agent_profiles ?? {});
	if (!names.includes('claude')) names.unshift('claude');
	return names;
}

export type AgentProfileCheck =
	| {kind: 'known'}
	| {kind: 'unknown'; names: string[]};

export function checkAgentProfile(
	config: PappardelleConfig,
	name: string,
): AgentProfileCheck {
	const names = agentProfileNames(config);
	return names.includes(name) ? {kind: 'known'} : {kind: 'unknown', names};
}

export function unknownAgentProfileMessage(
	name: string,
	names: string[],
): string {
	return `Unknown agent profile "${name}". Agent profiles: ${names.join(', ')}`;
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
 * A watchlist resolved for polling, tagged with the profile it belongs to.
 * `profileName` is null for the top-level `issue_watchlist`; otherwise it names
 * the owning profile (used to force `idow --profile <name>` and pick the right
 * rail emoji for workspaces this watchlist spawns).
 */
export interface ResolvedWatchlist {
	profileName: string | null;
	watchlist: IssueWatchlistConfig;
}

/**
 * Collect every watchlist the poller should run: the top-level
 * `issue_watchlist` (if any) plus each profile's own `issue_watchlist` (if any).
 * The lists are additive — a profile watchlist supplements, never replaces, the
 * top-level one. This is what makes "watch To Do everywhere, but also watch a
 * bespoke status for one project" expressible.
 *
 * Profile watchlists are auto-scoped to their team: when a profile watchlist
 * omits `key_prefixes`, the profile's effective `team_prefix`
 * (profile-level, else global) is injected as the sole key-prefix filter so it
 * only pulls in that team's issues. An explicit `key_prefixes` is left
 * untouched, and when no `team_prefix` is configured anywhere the watchlist is
 * left unscoped (matches every prefix, like the top-level watchlist).
 *
 * Order is significant: the top-level watchlist comes first, then profiles in
 * definition order. The poller spawns the first watchlist to match a given
 * issue and skips later duplicates, so on the (rare, misconfigured) overlap of
 * a profile watching the same status as the top-level, the top-level's spawn
 * wins. Disjoint statuses — the intended setup — never collide.
 *
 * Off-by-default guarantee: when no profile defines `issue_watchlist`, the
 * result is exactly `[{profileName: null, watchlist: config.issue_watchlist}]`
 * (or `[]` when there's no top-level watchlist either) — byte-identical to the
 * single-watchlist behavior that predated this function.
 */
export function getResolvedWatchlists(
	config: PappardelleConfig,
): ResolvedWatchlist[] {
	const resolved: ResolvedWatchlist[] = [];

	if (config.issue_watchlist) {
		// The top-level watchlist is intentionally never auto-scoped — it is the
		// "watch every project" catch-all.
		resolved.push({profileName: null, watchlist: config.issue_watchlist});
	}

	for (const [name, profile] of Object.entries(config.profiles)) {
		const wl = profile.issue_watchlist;
		if (!wl) continue;

		const hasExplicitPrefixes =
			Array.isArray(wl.key_prefixes) && wl.key_prefixes.length > 0;
		// Effective team prefix without getProfileTeamPrefix's hard 'STA' default:
		// we only auto-scope when a team_prefix is actually configured.
		const teamPrefix = profile.team_prefix ?? config.team_prefix;

		const watchlist =
			!hasExplicitPrefixes && teamPrefix
				? {...wl, key_prefixes: [teamPrefix]}
				: wl;

		resolved.push({profileName: name, watchlist});
	}

	return resolved;
}

/**
 * The configured issue-status color overrides for the ticket rail, or undefined
 * when the config has none (or could not be loaded at all).
 */
export function getStateColors(
	config: PappardelleConfig | null,
): Record<string, string> | undefined {
	return config?.state_colors;
}

/**
 * Whether to auto-remove spaces from the rail when their tracker issue
 * reports state.type === 'completed' or 'canceled'. Defaults to false so
 * legacy configs behave identically to master.
 */
export function getAutoRemoveWhenDone(config: PappardelleConfig): boolean {
	return config.auto_remove_when_done ?? false;
}

export const DEFAULT_SOUS_CHEF_KEY = 'M-s';

/**
 * The sous-chef jump key, or null when it is turned off. A config that failed
 * to load still gets the default.
 */
export function getSousChefKey(
	config: PappardelleConfig | null,
): string | null {
	const key = config?.sous_chef_key;
	if (key === false) return null;
	return key ?? DEFAULT_SOUS_CHEF_KEY;
}

export function getPaneWidths(config: PappardelleConfig | null): PaneWidths {
	const layout = config?.layout;
	return {
		rail: layout?.rail_width,
		claude: layout?.claude_width,
		companion: layout?.companion_width,
	};
}

export function isRailGroupedByStatus(
	config: PappardelleConfig | null,
): boolean {
	return config?.list_view?.group_by === 'status';
}

export function getRailGroups(config: PappardelleConfig | null): RailGroup[] {
	return railGroupsFromConfig(config?.list_view?.groups);
}

export function getListLayout(config: PappardelleConfig | null): ListLayout {
	const explicit = config?.list_view?.layout;
	if (explicit) return explicit;
	return config?.issue_tracker?.provider === 'beads'
		? 'two_line'
		: 'single_line';
}

/**
 * The command the companion pane runs when nothing is configured. gitui
 * replaced lazygit as the default in STA-1464. GIT_OPTIONAL_LOCKS=0 keeps the
 * git UI from taking lock files for read-only ops, avoiding contention with
 * Claude's concurrent git calls (the same hygiene the old lazygit default had).
 */
export const DEFAULT_COMPANION_COMMAND = 'GIT_OPTIONAL_LOCKS=0 gitui';

/**
 * Resolve the command for a space's companion pane.
 *
 * Resolution order (first defined wins): the matched profile's
 * `companion_command` → the top-level `companion_command` → the built-in
 * default (`gitui`). The profile comes from `launchProfile`: the space's saved
 * profile, else a keyword match on `issueTitle`. Omit both to resolve
 * top-level/default only.
 *
 * An explicitly configured empty string is preserved (it means "run nothing,
 * leave a plain shell") — only an *absent* value falls through to the next
 * level. `undefined` checks (not `??`) make that distinction.
 */
export function getCompanionCommand(
	config: PappardelleConfig,
	issueTitle?: string,
	profileName?: string,
): string {
	const profile = selectProfile(config, issueTitle, profileName);
	if (profile?.companion_command !== undefined) {
		return profile.companion_command;
	}
	return config.companion_command ?? DEFAULT_COMPANION_COMMAND;
}

/**
 * The splits a space's companion starts with: the matched profile's
 * `companion_splits`, else the top-level list, chosen the same way as
 * `getCompanionCommand`.
 */
export function getCompanionSplits(
	config: PappardelleConfig,
	issueTitle?: string,
	profileName?: string,
): ResolvedCompanionSplit[] {
	const profile = selectProfile(config, issueTitle, profileName);
	const splits = profile?.companion_splits ?? config.companion_splits ?? [];
	return splits.map(split => ({...split, split: split.split ?? DEFAULT_SPLIT}));
}

// eslint-disable-next-line no-template-curly-in-string
export const DEFAULT_IDE_COMMAND = 'cursor "${WORKTREE_PATH}"';

export function getIdeCommand(
	config: PappardelleConfig,
	profileName?: string,
): string {
	if (profileName) {
		const profile = config.profiles[profileName];
		if (profile?.ide_command !== undefined) {
			return profile.ide_command;
		}
	}
	return config.ide_command ?? DEFAULT_IDE_COMMAND;
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
 *
 * `profileName` names the profile directly and wins over the title match. Pass
 * it whenever the caller has already resolved a profile — otherwise the vars
 * can come from a different profile than the command they are expanded into,
 * leaving that command's own `vars:` unset.
 */
export function buildWorkspaceTemplateVars(
	issueKey: string,
	worktreePath: string,
	config: PappardelleConfig | null,
	issueTitle?: string,
	profileName?: string,
): TemplateVars {
	const vars: TemplateVars = {
		ISSUE_KEY: issueKey,
		WORKTREE_PATH: worktreePath,
		REPO_ROOT: getRepoRoot(),
		MAIN_REPO_ROOT: getMainRepoRoot(),
		REPO_NAME: getRepoName(),
		SCRIPT_DIR: scriptsDir,
	};
	if (!config) return vars;

	let profile: Profile | undefined;

	if (profileName) {
		profile = config.profiles[profileName];
	}

	if (!profile && issueTitle) {
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

	return vars;
}
