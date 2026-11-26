import type {AgentProfileConfig} from './config.ts';
import {builtinPromptFlag, LAUNCH_FIELDS} from './config-launch-flags.ts';
import {dismissRecentErrors, logger} from './logger.ts';

const DEPRECATED_CLAUDE_FIELDS = [
	'initialization_command',
	...LAUNCH_FIELDS,
	'extra_args',
] as const;

type DeprecatedClaudeField = (typeof DEPRECATED_CLAUDE_FIELDS)[number];

function initCommandSpellings(container: Record<string, unknown>): {
	newKey: boolean;
	oldKey: boolean;
} {
	const {claude} = container;
	return {
		newKey: container['initialization_command'] !== undefined,
		oldKey:
			claude !== null &&
			typeof claude === 'object' &&
			(claude as Record<string, unknown>)['initialization_command'] !==
				undefined,
	};
}

/**
 * The containers an initialization_command can live on — the config's top
 * level plus each profile — with the message label for each (`''` at the top
 * level, `profiles.<name>.` per profile, ready to prefix a key path).
 */
function configContainers(layer: Record<string, unknown>): Array<{
	container: Record<string, unknown>;
	label: string;
	profileName?: string;
}> {
	const containers: Array<{
		container: Record<string, unknown>;
		label: string;
		profileName?: string;
	}> = [{container: layer, label: ''}];
	const {profiles} = layer;
	if (profiles && typeof profiles === 'object') {
		for (const [name, profile] of Object.entries(
			profiles as Record<string, unknown>,
		)) {
			if (!profile || typeof profile !== 'object') continue;
			containers.push({
				container: profile as Record<string, unknown>,
				label: `profiles.${name}.`,
				profileName: name,
			});
		}
	}
	return containers;
}

/**
 * Same-file both-spellings conflicts, top-level and per-profile, labeled with
 * the layer's file name. Runs on a single raw layer before merging.
 */
export function initializationCommandConflictErrors(
	layer: Record<string, unknown>,
	file: string,
): string[] {
	const errors: string[] = [];
	for (const {container, label} of configContainers(layer)) {
		const {newKey, oldKey} = initCommandSpellings(container);
		if (newKey && oldKey) {
			errors.push(
				`${file}: ${label}initialization_command and ${label}claude.initialization_command cannot both be specified (use initialization_command)`,
			);
		}
	}
	return errors;
}

/**
 * Move a raw layer's deprecated `claude.initialization_command` to the
 * `initialization_command` key beside it. Runs after the per-layer conflict
 * check, so the new key is never already set. A non-string value stays put so
 * validateConfig reports the type error under the key the user wrote.
 */
export function renameDeprecatedInitializationCommand(
	layer: Record<string, unknown>,
): void {
	for (const {container} of configContainers(layer)) {
		const {claude} = container;
		if (!claude || typeof claude !== 'object') continue;
		const claudeFields = claude as Record<string, unknown>;
		const value = claudeFields['initialization_command'];
		if (typeof value !== 'string') continue;
		container['initialization_command'] = value;
		delete claudeFields['initialization_command'];
	}
}

/**
 * Each distinct deprecation warning fires once per process: the TUI reloads
 * config on every space selection, and re-warning on each reload would fill
 * the logger's small recent-error buffer and evict real errors from the
 * overlay.
 */
const emittedDeprecationWarnings = new Set<string>();

function warnDeprecatedOnce(message: string): void {
	if (emittedDeprecationWarnings.has(message)) {
		return;
	}

	emittedDeprecationWarnings.add(message);
	logger.warn(message);
}

/** Drop the deprecation warnings from the error pane, except the `remaining` ones the config still earns. */
export function dismissDeprecationWarnings(
	remaining: ReadonlySet<string> = new Set(),
): void {
	const stale = new Set(
		[...emittedDeprecationWarnings].filter(message => !remaining.has(message)),
	);
	dismissRecentErrors(entry => stale.has(entry.message));
	for (const message of stale) emittedDeprecationWarnings.delete(message);
}

/**
 * Every deprecated `claude.<field>` a raw layer sets, top-level or
 * per-profile, with the profile-name label of the container it sits in.
 */
export function findDeprecatedClaudeFields(
	layer: Record<string, unknown>,
): Array<{label: string; profileName?: string; field: DeprecatedClaudeField}> {
	return configContainers(layer).flatMap(({container, label, profileName}) => {
		const {claude} = container;
		if (!claude || typeof claude !== 'object') return [];
		return DEPRECATED_CLAUDE_FIELDS.filter(
			field => (claude as Record<string, unknown>)[field] !== undefined,
		).map(field => ({label, profileName, field}));
	});
}

function deprecationMessage(
	file: string,
	label: string,
	field: DeprecatedClaudeField,
): string {
	switch (field) {
		case 'initialization_command': {
			const target = label
				? `${label}initialization_command`
				: 'the top-level initialization_command';
			return `${file}: ${label}claude.initialization_command is deprecated — rename it to ${target}`;
		}

		case 'extra_args': {
			return `${file}: ${label}claude.extra_args is deprecated — set args on an agent profile (agent_profiles.<name>.args) and select it with ${label}agent_profile`;
		}

		case 'model':
		case 'effort': {
			return `${file}: ${label}claude.${field} is deprecated — set ${field} on an agent profile (agent_profiles.<name>.${field}) and select it with ${label}agent_profile`;
		}
	}
}

/**
 * Log a deprecation warning per deprecated `claude.<field>` in a single
 * config layer. Runs on the raw layer, before the initialization_command
 * rename, so the warning names the file to edit. `claude.model` / `effort` /
 * `extra_args` keep working for claude agent profiles, so unlike the init
 * command they are not renamed; the warning only points at where the value
 * belongs now.
 */
export function warnDeprecatedClaudeFields(
	layer: Record<string, unknown>,
	file: string,
	agentProfiles: Record<string, unknown>,
): void {
	for (const message of deprecationWarnings(layer, file, agentProfiles)) {
		warnDeprecatedOnce(message);
	}
}

export function deprecationWarnings(
	layer: Record<string, unknown>,
	file: string,
	agentProfiles: Record<string, unknown>,
): string[] {
	return [
		...findDeprecatedClaudeFields(layer).map(({label, field}) =>
			deprecationMessage(file, label, field),
		),
		...findPrefixedInitializationCommands(layer).map(
			({key, value}) =>
				`${file}: ${key} "${value}" includes the skill prefix — write "${value.slice(1)}"; the agent profile's skill_prefix is added at launch`,
		),
		...(hasSqliteStateFlag(layer)
			? [
					`${file}: experimental.sqliteState is deprecated — Pappardelle always keeps its state in SQLite, so delete it`,
				]
			: []),
		...findTrailingPromptFlags(layer, agentProfiles).map(
			({name, field, flag}) =>
				`${file}: agent_profiles.${name}.${field} ends with ${flag}, which the built-in prompt_args now adds — remove it`,
		),
	];
}

function hasSqliteStateFlag(layer: Record<string, unknown>): boolean {
	const {experimental} = layer;
	return (
		typeof experimental === 'object' &&
		experimental !== null &&
		'sqliteState' in experimental
	);
}

/**
 * Every initialization_command a raw layer writes in the old form, with the
 * skill's `/` in front, in either spelling. That form predates skill_prefix:
 * read as a skill name, `/idow` would launch claude with `//idow`.
 */
export function findPrefixedInitializationCommands(
	layer: Record<string, unknown>,
): Array<{key: string; value: string}> {
	return configContainers(layer).flatMap(({container, label}) =>
		[
			{key: 'initialization_command', fields: container},
			{key: 'claude.initialization_command', fields: container['claude']},
		].flatMap(({key, fields}) => {
			const value =
				fields && typeof fields === 'object'
					? (fields as Record<string, unknown>)['initialization_command']
					: undefined;
			return typeof value === 'string' && value.startsWith('/')
				? [{key: `${label}${key}`, value}]
				: [];
		}),
	);
}

/**
 * Every model_args or effort_args a raw layer sets that still ends with the
 * prompt flag its agent's built-in prompt_args adds (see builtinPromptFlag).
 * The agent is read from the merged agent profiles, since another file can
 * set its command or prompt_args.
 */
export function findTrailingPromptFlags(
	layer: Record<string, unknown>,
	agentProfiles: Record<string, unknown>,
): Array<{name: string; field: 'model_args' | 'effort_args'; flag: string}> {
	const profiles = layer['agent_profiles'];
	if (!profiles || typeof profiles !== 'object') return [];
	return Object.entries(profiles as Record<string, unknown>).flatMap(
		([name, value]) => {
			const definition = agentProfiles[name] as
				| Partial<AgentProfileConfig>
				| undefined;
			if (typeof definition?.command !== 'string') return [];
			const flag = builtinPromptFlag(definition as AgentProfileConfig);
			if (!flag) return [];
			const fields = value as Partial<AgentProfileConfig> | null;
			return (['model_args', 'effort_args'] as const)
				.filter(field => {
					const args = fields?.[field];
					return (
						typeof args === 'string' && args.trimEnd().endsWith(` ${flag}`)
					);
				})
				.map(field => ({name, field, flag}));
		},
	);
}

/** Whether a raw layer still uses a format the config rewrite replaces. */
export function needsConfigRewrite(
	layer: Record<string, unknown>,
	agentProfiles: Record<string, unknown>,
): boolean {
	return (
		findDeprecatedClaudeFields(layer).length > 0 ||
		findPrefixedInitializationCommands(layer).length > 0 ||
		findTrailingPromptFlags(layer, agentProfiles).length > 0
	);
}
