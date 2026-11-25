import {
	isPaneName,
	isSplitDirection,
	MAIN_PANE,
	PANE_NAME_RULE,
} from './companion-splits.ts';
import type {AgentProfileConfig, PappardelleConfig} from './config.ts';
import {ConfigValidationError} from './config-errors.ts';
import {
	AGENT_PROFILE_LAUNCH_FIELDS,
	AGENT_PROFILE_LAUNCH_PLACEHOLDERS,
	builtinAgentDefaults,
	isAgyAgentProfile,
	LAUNCH_FIELDS,
	PROMPT_PLACEHOLDER,
} from './config-launch-flags.ts';
import {isPaneWidth} from './layout-sizing.ts';
import {railGroupId, STATUS_CATEGORIES} from './rail-groups.ts';
import {
	ANSI_COLOR_NAMES,
	isValidStateColor,
	normalizeStateName,
} from './state-color-override.ts';

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
export const DEFAULT_KEYBINDING_KEYS = new Set([
	'g',
	'i',
	'd',
	'o',
	'e',
	'p',
	'K',
	's',
]);

/**
 * Union of NON_OVERRIDABLE_KEYS and DEFAULT_KEYBINDING_KEYS.
 * Kept for backwards compatibility and tests that need the full set.
 */
export const RESERVED_KEYS = new Set([
	...NON_OVERRIDABLE_KEYS,
	...DEFAULT_KEYBINDING_KEYS,
]);

export function validateConfig(
	config: unknown,
): asserts config is PappardelleConfig {
	const errors = configErrors(config);
	if (errors.length > 0) {
		throw new ConfigValidationError(errors);
	}
}

/**
 * What validateConfig rejects the config for, or none. Like validateConfig it
 * fills in the defaults it checks (default_profile, each profile's keywords).
 */
export function configErrors(config: unknown): string[] {
	const errors: string[] = [];

	if (!config || typeof config !== 'object') {
		return ['Config must be an object'];
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
			const {provider} = it;
			if (
				provider !== 'linear' &&
				provider !== 'jira' &&
				provider !== 'beads'
			) {
				errors.push(
					'issue_tracker.provider: must be "linear", "jira", or "beads"',
				);
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
			const {provider} = vh;
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
			errors.push(...validateClaudeLaunchFields(cl, 'claude'));
		}
	}

	// Check initialization_command (optional)
	errors.push(...validateInitializationCommandField(cfg, ''));

	// Check agent_profiles (optional map of named agent profiles)
	const agentProfileNames = new Set<string>(['claude']);
	if (cfg['agent_profiles'] !== undefined) {
		if (
			typeof cfg['agent_profiles'] !== 'object' ||
			cfg['agent_profiles'] === null ||
			Array.isArray(cfg['agent_profiles'])
		) {
			errors.push('agent_profiles: must be an object');
		} else {
			for (const [name, def] of Object.entries(
				cfg['agent_profiles'] as Record<string, unknown>,
			)) {
				agentProfileNames.add(name);
				if (typeof def !== 'object' || def === null) {
					errors.push(`agent_profiles.${name}: must be an object`);
					continue;
				}
				const agentProfile = def as Record<string, unknown>;
				if (
					typeof agentProfile['command'] !== 'string' ||
					agentProfile['command'].trim().length === 0
				) {
					errors.push(
						`agent_profiles.${name}.command: required non-empty string`,
					);
				}
				for (const field of AGENT_PROFILE_STRING_FIELDS) {
					if (
						agentProfile[field] !== undefined &&
						typeof agentProfile[field] !== 'string'
					) {
						errors.push(`agent_profiles.${name}.${field}: must be a string`);
					}
				}
				// The fields are typed into the pane as one launch line.
				for (const field of ['command', ...AGENT_PROFILE_STRING_FIELDS]) {
					const value = agentProfile[field];
					if (typeof value === 'string' && /[\r\n]/.test(value.trimEnd())) {
						errors.push(
							`agent_profiles.${name}.${field}: must be a single line`,
						);
					}
				}
				if (
					agentProfile['is_claude'] !== undefined &&
					typeof agentProfile['is_claude'] !== 'boolean'
				) {
					errors.push(`agent_profiles.${name}.is_claude: must be a boolean`);
				}
				errors.push(
					...validateAgentProfileEnv(name, agentProfile['env']),
					...validateAgentLaunchTemplates(
						name,
						agentProfile as Partial<AgentProfileConfig>,
					),
				);
			}
		}
	}

	// Check agent_profile (optional reference into the agent_profiles map;
	// 'claude' is built in)
	if (cfg['agent_profile'] !== undefined) {
		errors.push(
			...validateAgentProfileReference(
				cfg['agent_profile'],
				'agent_profile',
				agentProfileNames,
			),
		);
	}

	// Check issue_watchlist (optional). Same shape is also accepted per-profile,
	// so the field checks live in a shared helper keyed by an error-message prefix.
	if (cfg['issue_watchlist'] !== undefined) {
		errors.push(
			...validateIssueWatchlist(cfg['issue_watchlist'], 'issue_watchlist'),
		);
	}

	// Check state_colors (optional, off by default)
	if (cfg['state_colors'] !== undefined) {
		errors.push(...validateStateColors(cfg['state_colors']));
	}

	// Check auto_remove_when_done (optional, off by default)
	if (
		cfg['auto_remove_when_done'] !== undefined &&
		typeof cfg['auto_remove_when_done'] !== 'boolean'
	) {
		errors.push('auto_remove_when_done: must be a boolean');
	}

	const sousChefKey = cfg['sous_chef_key'];
	if (
		sousChefKey !== undefined &&
		sousChefKey !== false &&
		(typeof sousChefKey !== 'string' || sousChefKey.trim() === '')
	) {
		errors.push('sous_chef_key: must be a tmux key name or false');
	}
	if (cfg['sous_chef'] !== undefined && typeof cfg['sous_chef'] !== 'boolean') {
		errors.push('sous_chef: must be a boolean');
	} else if (
		cfg['sous_chef'] === true &&
		cfg['workspace_aware_agents'] !== true
	) {
		errors.push(
			'sous_chef: needs workspace_aware_agents: true, since the sous-chef works through its tools',
		);
	}

	if (
		cfg['workspace_aware_agents'] !== undefined &&
		typeof cfg['workspace_aware_agents'] !== 'boolean'
	) {
		errors.push('workspace_aware_agents: must be a boolean');
	}

	const {experimental} = cfg;
	if (experimental !== undefined) {
		if (
			typeof experimental !== 'object' ||
			experimental === null ||
			Array.isArray(experimental)
		) {
			errors.push('experimental: must be an object');
		} else if (
			(experimental as Record<string, unknown>)['sqliteState'] !== undefined &&
			typeof (experimental as Record<string, unknown>)['sqliteState'] !==
				'boolean'
		) {
			errors.push('experimental.sqliteState: must be a boolean');
		}
	}

	// Check list_view (optional; an absent layout defers to the tracker default)
	if (cfg['list_view'] !== undefined) {
		if (typeof cfg['list_view'] !== 'object' || cfg['list_view'] === null) {
			errors.push('list_view: must be an object');
		} else {
			const listView = cfg['list_view'] as Record<string, unknown>;
			if (
				listView['layout'] !== undefined &&
				listView['layout'] !== 'single_line' &&
				listView['layout'] !== 'two_line'
			) {
				errors.push('list_view.layout: must be "single_line" or "two_line"');
			}

			if (
				listView['group_by'] !== undefined &&
				listView['group_by'] !== 'status'
			) {
				errors.push('list_view.group_by: must be "status"');
			}

			if (listView['groups'] !== undefined) {
				errors.push(...validateRailGroups(listView['groups']));
			}
		}
	}

	// Check layout (optional pane widths)
	if (cfg['layout'] !== undefined) {
		if (typeof cfg['layout'] !== 'object' || cfg['layout'] === null) {
			errors.push('layout: must be an object');
		} else {
			const layout = cfg['layout'] as Record<string, unknown>;
			for (const key of ['rail_width', 'claude_width', 'companion_width']) {
				const value = layout[key];
				if (value !== undefined && !isPaneWidth(value)) {
					errors.push(
						`layout.${key}: must be a positive whole number of columns or a percentage like "25%"`,
					);
				}
			}
		}
	}

	// Check companion_command (optional, free-form shell command). Any string is
	// accepted — including the empty string, which means "leave a plain shell".
	if (
		cfg['companion_command'] !== undefined &&
		typeof cfg['companion_command'] !== 'string'
	) {
		errors.push('companion_command: must be a string');
	}

	validateCompanionSplits(cfg['companion_splits'], 'companion_splits', errors);

	// Check ide_command (optional, free-form shell command). Any string is
	// accepted — including the empty string, which disables the `d` key.
	if (
		cfg['ide_command'] !== undefined &&
		typeof cfg['ide_command'] !== 'string'
	) {
		errors.push('ide_command: must be a string');
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
				if (!binding || typeof binding !== 'object') {
					errors.push(`keybindings[${i}]: must be a map`);
					continue;
				}

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
				const actions = ['run', 'send_to_claude', 'send_skill'].filter(
					action => typeof binding[action] === 'string',
				);
				if (actions.length !== 1) {
					errors.push(
						`keybindings[${i}]: must have exactly one of 'run', 'send_to_claude' or 'send_skill'`,
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
			const profileErrors = validateProfile(name, profile, agentProfileNames);
			errors.push(...profileErrors);
		}
	}

	return errors;
}

const AGENT_PROFILE_STRING_FIELDS = [
	'args',
	'resume_args',
	'model',
	'effort',
	'mode',
	'model_args',
	'effort_args',
	'mode_args',
	'prompt_args',
	'skill_prefix',
] as const;

const AGY_MODES = ['accept-edits', 'auto', 'plan'] as const;
const AGY_MODE_SET = new Set<string>(AGY_MODES);
const AGY_MODES_LABEL = [
	...AGY_MODES.slice(0, -1).map(m => `"${m}"`),
	`or "${AGY_MODES.at(-1)}"`,
].join(', ');

// agy 1.5.16 warns and silently switches to Gemini 4 Neon (High) when an
// effort-suffixed model id is combined with an explicit --effort flag.
const AGY_EFFORT_SUFFIX_PATTERN = /-(?:low|medium|high|xhigh|max)$/;

const ENV_NAME_PATTERN = /^[A-Za-z_]\w*$/;

function validateAgentProfileEnv(name: string, env: unknown): string[] {
	if (env === undefined) return [];
	if (typeof env !== 'object' || env === null || Array.isArray(env)) {
		return [
			`agent_profiles.${name}.env: must be a map of variable names to strings`,
		];
	}

	return Object.entries(env).flatMap(([key, value]) => {
		const prefix = `agent_profiles.${name}.env.${key}`;
		if (!ENV_NAME_PATTERN.test(key)) {
			return [`${prefix}: must be an environment variable name`];
		}

		if (key.startsWith('PAPPARDELLE_')) {
			return [`${prefix}: PAPPARDELLE_ variables are set by pappardelle`];
		}

		return typeof value === 'string' ? [] : [`${prefix}: must be a string`];
	});
}

/**
 * A template must carry its placeholder, or the configured value would be
 * silently dropped; and a value with no template, built in or configured,
 * has no way to reach the CLI.
 */
function validateAgentLaunchTemplates(
	name: string,
	agentProfile: Partial<AgentProfileConfig>,
): string[] {
	if (typeof agentProfile.command !== 'string') return [];
	const errors: string[] = [];
	const builtin = builtinAgentDefaults({
		command: agentProfile.command,
		is_claude: agentProfile.is_claude,
	});
	for (const field of AGENT_PROFILE_LAUNCH_FIELDS) {
		const templateField = `${field}_args` as const;
		const template = agentProfile[templateField];
		const placeholder = AGENT_PROFILE_LAUNCH_PLACEHOLDERS[field];
		if (typeof template === 'string' && !template.includes(placeholder)) {
			errors.push(
				`agent_profiles.${name}.${templateField}: must contain ${placeholder}`,
			);
		}
		const value = agentProfile[field];
		if (
			typeof value === 'string' &&
			value !== '' &&
			template === undefined &&
			builtin[templateField] === undefined
		) {
			errors.push(
				`agent_profiles.${name}.${field}: "${agentProfile.command}" has no built-in ${field} flag; set ${templateField}`,
			);
		}
	}
	if (
		isAgyAgentProfile({
			command: agentProfile.command,
			is_claude: agentProfile.is_claude,
		})
	) {
		errors.push(...validateAgyAgentProfile(name, agentProfile));
	}
	const promptArgs = agentProfile.prompt_args;
	if (
		typeof promptArgs === 'string' &&
		promptArgs.split(PROMPT_PLACEHOLDER).length !== 2
	) {
		errors.push(
			`agent_profiles.${name}.prompt_args: must contain ${PROMPT_PLACEHOLDER} exactly once`,
		);
	}
	return errors;
}

function validateAgyAgentProfile(
	name: string,
	agentProfile: Partial<AgentProfileConfig>,
): string[] {
	const errors: string[] = [];
	if (typeof agentProfile.mode === 'string') {
		const mode = agentProfile.mode.trimEnd();
		if (mode !== '' && !AGY_MODE_SET.has(mode)) {
			errors.push(`agent_profiles.${name}.mode: must be ${AGY_MODES_LABEL}`);
		}
	}
	const model =
		typeof agentProfile.model === 'string'
			? agentProfile.model.trimEnd()
			: undefined;
	if (
		model !== undefined &&
		typeof agentProfile.effort === 'string' &&
		agentProfile.effort.trimEnd() !== '' &&
		AGY_EFFORT_SUFFIX_PATTERN.test(model)
	) {
		errors.push(
			`agent_profiles.${name}: model "${model}" already includes an effort suffix; remove effort or use the base model name`,
		);
	}
	return errors;
}

/**
 * Validate the pass-through launch flags in a `claude:` block.
 *
 * Type-only on purpose: these values are handed straight to `claude --model` /
 * `claude --effort`, and any allowlist we bake in here would rot the moment a
 * new model alias or effort level ships. A typo therefore surfaces when Claude
 * Code itself rejects the flag, not at config load. Every consumer
 * shell-quotes the value, so "loose" costs nothing in safety.
 *
 * An empty string is explicitly legal and meaningful: at profile level it
 * clears a value inherited from the top-level block.
 */
function validateClaudeLaunchFields(
	claudeBlock: Record<string, unknown>,
	prefix: string,
): string[] {
	const errors: string[] = [];
	for (const field of LAUNCH_FIELDS) {
		if (
			claudeBlock[field] !== undefined &&
			typeof claudeBlock[field] !== 'string'
		) {
			errors.push(`${prefix}.${field}: must be a string`);
		}
	}
	const extraArgs = claudeBlock['extra_args'];
	if (
		extraArgs !== undefined &&
		!(
			Array.isArray(extraArgs) &&
			extraArgs.every(arg => typeof arg === 'string')
		)
	) {
		errors.push(`${prefix}.extra_args: must be a list of strings`);
	}
	return errors;
}

/**
 * Validate a single issue_watchlist block. Shared by the top-level
 * `issue_watchlist` and each profile's `issue_watchlist` so their field rules
 * and error messages can never drift. `prefix` is the dotted path used in error
 * messages (e.g. `issue_watchlist` or `profiles.chaz.issue_watchlist`).
 */
function validateIssueWatchlist(value: unknown, prefix: string): string[] {
	const errors: string[] = [];

	if (typeof value !== 'object' || value === null) {
		errors.push(`${prefix}: must be an object`);
		return errors;
	}

	const wl = value as Record<string, unknown>;
	if (wl['assignee'] !== undefined && typeof wl['assignee'] !== 'string') {
		errors.push(`${prefix}.assignee: must be a string`);
	}

	if (!Array.isArray(wl['statuses']) || wl['statuses'].length === 0) {
		errors.push(`${prefix}.statuses: required non-empty array`);
	} else {
		const statuses = wl['statuses'] as unknown[];
		for (let i = 0; i < statuses.length; i++) {
			if (typeof statuses[i] !== 'string') {
				errors.push(`${prefix}.statuses[${i}]: must be a string`);
			}
		}
	}

	if (wl['labels'] !== undefined) {
		if (!Array.isArray(wl['labels'])) {
			errors.push(`${prefix}.labels: must be an array`);
		} else {
			const labels = wl['labels'] as unknown[];
			for (let i = 0; i < labels.length; i++) {
				if (typeof labels[i] !== 'string') {
					errors.push(`${prefix}.labels[${i}]: must be a string`);
				}
			}
		}
	}

	if (wl['key_prefixes'] !== undefined) {
		if (!Array.isArray(wl['key_prefixes'])) {
			errors.push(`${prefix}.key_prefixes: must be an array`);
		} else {
			const prefixes = wl['key_prefixes'] as unknown[];
			for (let i = 0; i < prefixes.length; i++) {
				const p = prefixes[i];
				if (typeof p !== 'string') {
					errors.push(`${prefix}.key_prefixes[${i}]: must be a string`);
				} else if (p.trim() === '') {
					errors.push(`${prefix}.key_prefixes[${i}]: must not be empty`);
				}
			}
		}
	}

	if (wl['max_workspaces'] !== undefined) {
		const max = wl['max_workspaces'];
		if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
			errors.push(`${prefix}.max_workspaces: must be an integer >= 1`);
		}
	}

	return errors;
}

/**
 * Type-check `initialization_command` on one container (top level or profile).
 * Shared by validateConfig and validateProfile, keyed by an error-message
 * prefix (`''` at the top level, `profiles.<name>.` per profile) like
 * validateIssueWatchlist. Both-spellings conflicts are rejected per file in
 * loadConfigFromPaths, before layers merge.
 */
function validateInitializationCommandField(
	container: Record<string, unknown>,
	prefix: string,
): string[] {
	const errors: string[] = [];
	if (
		container['initialization_command'] !== undefined &&
		typeof container['initialization_command'] !== 'string'
	) {
		errors.push(`${prefix}initialization_command: must be a string`);
	}
	return errors;
}

/**
 * Validate an `agent_profile:` reference (top-level or per-profile). `''` clears an
 * inherited reference back to claude, so only non-empty names must resolve.
 */
function validateAgentProfileReference(
	value: unknown,
	label: string,
	agentProfileNames: Set<string>,
): string[] {
	if (typeof value !== 'string') {
		return [`${label}: must be a string`];
	}
	if (value !== '' && !agentProfileNames.has(value)) {
		return [`${label}: agent profile "${value}" not found in agent_profiles`];
	}
	return [];
}

function validateCompanionSplits(
	value: unknown,
	path: string,
	errors: string[],
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		errors.push(`${path}: must be a list of splits`);
		return;
	}

	const names = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const at = `${path}[${index}]`;
		if (typeof entry !== 'object' || entry === null) {
			errors.push(`${at}: must be an object with name and command`);
			continue;
		}

		const split = entry as Record<string, unknown>;
		if (!isPaneName(split['name']) || split['name'] === MAIN_PANE) {
			errors.push(`${at}.name: must be ${PANE_NAME_RULE}, and not main`);
		} else if (names.has(split['name'])) {
			errors.push(`${at}.name: ${split['name']} is listed twice`);
		} else {
			names.add(split['name']);
		}

		if (typeof split['command'] !== 'string')
			errors.push(`${at}.command: must be a string`);
		if (split['split'] !== undefined && !isSplitDirection(split['split']))
			errors.push(`${at}.split: must be right or down`);
		if (split['size'] !== undefined && !isPaneWidth(split['size']))
			errors.push(
				`${at}.size: must be a positive whole number of cells or a percentage like "30%"`,
			);
	}
}

function validateProfile(
	name: string,
	profile: unknown,
	agentProfileNames: Set<string>,
): string[] {
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

	// Optional per-profile companion_command override (any string, incl. empty)
	if (
		p['companion_command'] !== undefined &&
		typeof p['companion_command'] !== 'string'
	) {
		errors.push(`${prefix}.companion_command: must be a string`);
	}

	validateCompanionSplits(
		p['companion_splits'],
		`${prefix}.companion_splits`,
		errors,
	);

	// Optional per-profile ide_command override (any string, incl. empty)
	if (p['ide_command'] !== undefined && typeof p['ide_command'] !== 'string') {
		errors.push(`${prefix}.ide_command: must be a string`);
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
			errors.push(...validateClaudeLaunchFields(cl, `${prefix}.claude`));
		}
	}

	// Optional per-profile agent_profile reference ('' clears an inherited reference)
	if (p['agent_profile'] !== undefined) {
		errors.push(
			...validateAgentProfileReference(
				p['agent_profile'],
				`${prefix}.agent_profile`,
				agentProfileNames,
			),
		);
	}

	// Optional per-profile initialization_command
	errors.push(...validateInitializationCommandField(p, `${prefix}.`));

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

	// Optional per-profile issue_watchlist (same shape as the top-level one)
	if (p['issue_watchlist'] !== undefined) {
		errors.push(
			...validateIssueWatchlist(
				p['issue_watchlist'],
				`${prefix}.issue_watchlist`,
			),
		);
	}

	return errors;
}

/**
 * Validate the top-level `state_colors` map.
 *
 * Names are rejected when blank, or when two of them normalize to the same
 * string — the rail matches case-insensitively, so `In Progress` and
 * `in progress` would otherwise be an unresolvable tie decided by key order.
 */
function validateStateColors(value: unknown): string[] {
	const errors: string[] = [];

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		errors.push('state_colors: must be an object');
		return errors;
	}

	const seen = new Set<string>();
	for (const [name, color] of Object.entries(value)) {
		const normalized = normalizeStateName(name);
		if (normalized.length === 0) {
			errors.push('state_colors: state names must not be empty');
		} else if (seen.has(normalized)) {
			errors.push(
				`state_colors: duplicate state name "${normalized}" (names are matched case-insensitively)`,
			);
		} else {
			seen.add(normalized);
		}

		if (!isValidStateColor(color)) {
			errors.push(
				`state_colors."${name}": must be a hex color (#rgb or #rrggbb) or an ANSI color name (${[
					...ANSI_COLOR_NAMES,
				].join(', ')})`,
			);
		}
	}

	return errors;
}

function validateRailGroups(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		return ['list_view.groups: must be a non-empty list'];
	}

	const errors: string[] = [];
	const names = new Set<string>();
	const statusOwners = new Map<string, string>();
	for (const [index, item] of value.entries()) {
		const at = `list_view.groups[${index}]`;
		if (typeof item !== 'object' || item === null) {
			errors.push(`${at}: must be an object`);
			continue;
		}

		const group = item as Record<string, unknown>;
		const {name, color, statuses, categories} = group;
		if (typeof name !== 'string' || name.trim().length === 0) {
			errors.push(`${at}.name: must be a non-empty string`);
		} else if (names.has(railGroupId(name))) {
			errors.push(`${at}.name: duplicate group "${name}"`);
		} else {
			names.add(railGroupId(name));
		}

		if (!isValidStateColor(color)) {
			errors.push(
				`${at}.color: must be a hex color (#rgb or #rrggbb) or an ANSI color name`,
			);
		}

		const isEmpty = (list: unknown) =>
			list === undefined || (Array.isArray(list) && list.length === 0);
		if (isEmpty(statuses) && isEmpty(categories)) {
			errors.push(`${at}: needs statuses, categories or both`);
		}

		if (statuses !== undefined) {
			if (
				!Array.isArray(statuses) ||
				statuses.some(s => typeof s !== 'string' || s.trim().length === 0)
			) {
				errors.push(`${at}.statuses: must be a list of status names`);
			} else {
				for (const status of statuses as string[]) {
					const key = normalizeStateName(status);
					const owner = statusOwners.get(key);
					if (owner !== undefined && owner !== at) {
						errors.push(`${at}.statuses: "${status}" is already in ${owner}`);
					}

					statusOwners.set(key, at);
				}
			}
		}

		if (
			categories !== undefined &&
			(!Array.isArray(categories) ||
				categories.some(
					c => !(STATUS_CATEGORIES as readonly unknown[]).includes(c),
				))
		) {
			errors.push(
				`${at}.categories: must be a list of ${STATUS_CATEGORIES.map(c => `"${c}"`).join(', ')}`,
			);
		}
	}

	return errors;
}
