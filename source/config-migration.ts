import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	isMap,
	isNode,
	isScalar,
	parseDocument,
	type Document,
	type Node,
	type Pair,
} from 'yaml';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {
	buildConfigFromLayers,
	configLayerFiles,
	defaultConfigPaths,
	deprecationWarnings,
	dismissDeprecationWarnings,
	findDeprecatedClaudeFields,
	getAgentProfile,
	getInitializationCommand,
	getNamedAgentProfile,
	LAUNCH_FIELDS,
	mergeConfigLayers,
	parseConfigLayer,
	quoteLaunchValue,
	renderAgentLaunchFlags,
	resolveAgentProfileName,
	type ConfigPaths,
	type PappardelleConfig,
} from './config.ts';

type Fields = Record<string, unknown>;

/** A config file still on the pre-agent-profile format, with its rewrite. */
export type ConfigMigration = {
	label: string;
	/** Where the file is, with the home directory shown as `~`. */
	displayPath: string;
	path: string;
	content: string;
};

/** A profile whose spaces launch a differently named agent profile after the rewrite. */
export type AgentProfileRename = {
	/** Undefined for spaces without a profile, like the main space. */
	profileName: string | undefined;
	from: string;
	to: string;
};

export type ConfigMigrationPlan =
	| {kind: 'none'}
	| {
			kind: 'ready';
			migrations: ConfigMigration[];
			renames: AgentProfileRename[];
	  }
	/** The old format is in use but can't be rewritten automatically. */
	| {kind: 'unsupported'; reason: string};

const [HOME_LABEL, PROJECT_LABEL] = configLayerFiles({}).map(
	({label}) => label,
);

type LayerFile = {
	label: string;
	path: string;
	content: string;
	layer: Fields | null;
};

function asFields(value: unknown): Fields | undefined {
	return value && typeof value === 'object' ? (value as Fields) : undefined;
}

function displayPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(`${home}/`)
		? `~${filePath.slice(home.length)}`
		: filePath;
}

function joinArgs(args: string, extraArgs: string[]): string {
	return [args, ...extraArgs.map(arg => quoteLaunchValue(arg))]
		.filter(Boolean)
		.join(' ');
}

/** The layers merged from the bottom up to and including `index`, unvalidated. */
function layersUpTo(files: LayerFile[], index: number): PappardelleConfig {
	const [home, project, local] = files
		.slice(0, index + 1)
		.map(({layer}) => (layer ? structuredClone(layer) : null));
	return mergeConfigLayers(
		home ?? null,
		project ?? null,
		local ?? null,
	) as unknown as PappardelleConfig;
}

/**
 * The agent profile a profile's own `claude:` launch fields move to. Chosen
 * against the whole config so every file names it the same, and never one
 * the user already defined.
 */
function profileAgentName(profileName: string, config: PappardelleConfig) {
	const taken = new Set(Object.keys(config.agent_profiles ?? {}));
	let name = `${profileName}-claude`;
	for (let n = 2; taken.has(name); n++) name = `${profileName}-claude-${n}`;
	return name;
}

function profilesWithLaunchFields(layer: Fields): string[] {
	return findDeprecatedClaudeFields(layer)
		.filter(
			({field, profileName}) =>
				profileName && field !== 'initialization_command',
		)
		.map(({profileName}) => profileName!);
}

function joinComments(...comments: Array<string | null | undefined>) {
	const kept = comments.filter(Boolean);
	return kept.length > 0 ? kept.join('\n') : undefined;
}

function pairAt(document: Document, at: string[]) {
	const parent =
		at.length === 1 ? document.contents : document.getIn(at.slice(0, -1), true);
	if (!isMap(parent)) return undefined;
	const items = parent.items as Pair[];
	const index = items.findIndex(
		({key}) => (isScalar(key) ? key.value : key) === at.at(-1),
	);
	return index === -1 ? undefined : {parent, pair: items[index]!, items, index};
}

/** Detach the comments written around a key, its value and its children. */
function takeComments(pair: Pair): string | undefined {
	const nodes = [pair.key, pair.value].filter(node => isNode(node));
	const comments: Array<string | undefined> = [];
	for (const node of nodes) {
		comments.push(node.commentBefore ?? undefined, node.comment ?? undefined);
		node.commentBefore = undefined;
		node.comment = undefined;
	}

	if (isMap(pair.value)) {
		for (const child of pair.value.items as Pair[]) {
			comments.push(takeComments(child));
		}
	}

	return joinComments(...comments);
}

/**
 * Remove a key without losing what the user wrote about it: its comments
 * move to `destination` when that key exists, else onto the next key, so a
 * file's header comment survives the removal of its first key.
 */
function removeKeepingComments(
	document: Document,
	at: string[],
	destination?: string[],
): void {
	const found = pairAt(document, at);
	if (!found) return;
	// A comment between `claude:` and its first key belongs to the map, but
	// the user wrote it about that key.
	const leading = found.index === 0 ? found.parent.commentBefore : undefined;
	if (found.index === 0) found.parent.commentBefore = undefined;
	const comment = joinComments(leading, takeComments(found.pair));
	found.items.splice(found.index, 1);
	if (!comment) return;
	const target = destination && pairAt(document, destination)?.pair;
	const next = target ?? found.items[found.index];
	if (next) {
		// Keys written by setIn are plain strings, which can't hold a comment.
		if (!isNode(next.key)) next.key = document.createNode(next.key);
		const key = next.key as Node;
		key.commentBefore = joinComments(comment, key.commentBefore);
		return;
	}

	found.parent.comment = joinComments(found.parent.comment, comment);
}

/**
 * Rewrite one file onto the agent-profile format. Values are resolved from
 * this file and the files beneath it only: the home config is shared by every
 * repo, so it must never pick up one repo's settings.
 */
function migrateLayer(
	file: LayerFile & {layer: Fields},
	below: PappardelleConfig,
	whole: PappardelleConfig,
	profilesMigratedBelow: Set<string>,
): string {
	const document = parseDocument(file.content);
	const deprecated = findDeprecatedClaudeFields(file.layer);
	const claudePath = (profileName?: string) =>
		profileName ? ['profiles', profileName, 'claude'] : ['claude'];

	const initPath = (profileName?: string) =>
		profileName
			? ['profiles', profileName, 'initialization_command']
			: ['initialization_command'];
	for (const {profileName, field} of deprecated) {
		if (field !== 'initialization_command') continue;
		const node = document.getIn([...claudePath(profileName), field], true);
		if (!isScalar(node) || typeof node.value !== 'string') continue;
		const copy = node.clone();
		copy.comment = undefined;
		copy.commentBefore = undefined;
		document.setIn(initPath(profileName), copy);
	}

	const ownsFallback = deprecated.some(
		({profileName, field}) =>
			!profileName && field !== 'initialization_command',
	);

	// A profile's own claude: launch fields become an agent profile holding
	// what the profile launches with today. A profile on another CLI never
	// read them, so they are only dropped. A file that sets the top-level
	// fallback rewrites the ones made beneath it too, since its values now
	// fill the fields those profiles leave unset.
	const profilesToMigrate = new Set([
		...profilesWithLaunchFields(file.layer),
		...(ownsFallback ? profilesMigratedBelow : []),
	]);
	const profileAgents = new Map<string, string>();
	for (const profileName of profilesToMigrate) {
		const resolved = getAgentProfile(below, undefined, profileName);
		if (!resolved.isClaude) continue;
		const definition = below.agent_profiles?.[resolved.name] ?? {
			command: 'claude',
		};
		const launch = {
			model: resolved.model,
			effort: resolved.effort,
			args: joinArgs(resolved.args, resolved.extraArgs),
		};
		// An empty value is only written where it has something to clear: the
		// copied definition's own value, or one written for this agent profile
		// by a file beneath this one.
		const clears = (key: keyof typeof launch) =>
			definition[key] !== undefined || profilesMigratedBelow.has(profileName);
		const name = profileAgentName(profileName, whole);
		document.setIn(['agent_profiles', name], {
			...definition,
			...Object.fromEntries(
				Object.entries(launch).filter(
					([key, value]) => value !== '' || clears(key as keyof typeof launch),
				),
			),
		});
		document.setIn(['profiles', profileName, 'agent_profile'], name);
		profileAgents.set(profileName, name);
	}

	// The top-level claude: launch fields were the fallback for every claude
	// agent profile that set none of its own. Each one this file defines takes
	// the value it launched with, and so does every one beneath it when this
	// file is where the fallback was set.
	const names = new Set(
		Object.keys(asFields(file.layer['agent_profiles']) ?? {}),
	);
	if (ownsFallback) {
		names.add('claude');
		for (const name of Object.keys(below.agent_profiles ?? {})) names.add(name);
	}

	const ownFallback = asFields(file.layer['claude']) ?? {};
	for (const name of names) {
		const resolved = getNamedAgentProfile(below, name);
		if (!resolved.isClaude) continue;
		const own = below.agent_profiles?.[name];
		const entry = ['agent_profiles', name];
		const set = (key: string, value: string) => {
			if (!own && !document.hasIn([...entry, 'command'])) {
				document.setIn([...entry, 'command'], resolved.command);
			}

			document.setIn([...entry, key], value);
		};

		// This file's own empty value overrides one a file beneath it set.
		for (const field of LAUNCH_FIELDS) {
			if (
				own?.[field] === undefined &&
				(resolved[field] !== '' || ownFallback[field] !== undefined)
			) {
				set(field, resolved[field]);
			}
		}

		if (
			resolved.extraArgs.length > 0 ||
			ownFallback['extra_args'] !== undefined
		) {
			set('args', joinArgs(resolved.args, resolved.extraArgs));
		}
	}

	for (const {profileName, field} of deprecated) {
		const agent = profileName ? profileAgents.get(profileName) : 'claude';
		const destination =
			field === 'initialization_command'
				? initPath(profileName)
				: agent
					? ['agent_profiles', agent, field === 'extra_args' ? 'args' : field]
					: undefined;
		removeKeepingComments(
			document,
			[...claudePath(profileName), field],
			destination,
		);
	}

	for (const {profileName} of deprecated) {
		const claude = document.getIn(claudePath(profileName));
		if (isMap(claude) && claude.items.length === 0) {
			removeKeepingComments(document, claudePath(profileName));
		}
	}

	// yaml pads flow collections and folds long lines by default, which would
	// rewrite lines the migration never touched.
	return document.toString({lineWidth: 0, flowCollectionPadding: false});
}

/**
 * Each extra arg was passed as its own argument, so one may hold a newline;
 * an agent profile's args are a single line, which can't carry it.
 */
function multiLineExtraArg(files: LayerFile[]): string | undefined {
	for (const {label, layer} of files) {
		if (!layer) continue;
		for (const {profileName} of findDeprecatedClaudeFields(layer).filter(
			({field}) => field === 'extra_args',
		)) {
			const claude = asFields(
				profileName
					? asFields(asFields(layer['profiles'])?.[profileName])?.['claude']
					: layer['claude'],
			);
			const extraArgs = claude?.['extra_args'];
			if (
				Array.isArray(extraArgs) &&
				extraArgs.some(arg => typeof arg === 'string' && arg.includes('\n'))
			) {
				const where = profileName ? `profiles.${profileName}.` : '';
				return `${label}: ${where}claude.extra_args has a multi-line value, and an agent profile's args must fit on one line`;
			}
		}
	}

	return undefined;
}

/**
 * The rewrite moves extra_args ahead of the model and effort flags, and claude
 * takes the last of a repeated flag, so an extra arg repeating one of them
 * would flip which value wins, and a `--` would turn them into arguments.
 */
function repeatedLaunchFlag(config: PappardelleConfig): string | undefined {
	for (const profileName of [undefined, ...Object.keys(config.profiles)]) {
		const agent = getAgentProfile(config, undefined, profileName);
		if (!agent.isClaude) continue;
		const where = profileName
			? `for profile "${profileName}"`
			: 'at the top level';
		const templates = {model: agent.modelArgs, effort: agent.effortArgs};
		for (const field of LAUNCH_FIELDS) {
			if (!agent[field]) continue;
			if (agent.extraArgs.includes('--')) {
				return `claude.extra_args has --, and the rewrite would put the ${field} flag ${where} after it`;
			}

			const flag = templates[field]
				?.split(/\s+/)
				.find(token => token.startsWith('-'))
				?.split('=')[0];
			if (
				flag &&
				agent.extraArgs.some(arg => arg === flag || arg.startsWith(`${flag}=`))
			) {
				return `claude.extra_args repeats ${flag}, and the rewrite would change which ${field} wins ${where}`;
			}
		}
	}

	return undefined;
}

/** What a space launches with, for comparing a config before and after. */
function launches(config: PappardelleConfig): Record<string, string> {
	const topInit = getInitializationCommand(config);
	return Object.fromEntries(
		[undefined, ...Object.keys(config.profiles)].map(profileName => {
			const agent = getAgentProfile(config, undefined, profileName);
			// Flag order isn't kept: extra_args move into args, ahead of the
			// model/effort flags, which no CLI cares about.
			const flags =
				`${agent.command} ${agent.args}${renderAgentLaunchFlags(agent)}`
					.split(/\s+/)
					.filter(Boolean)
					.sort()
					.join(' ');
			const init = profileName
				? (config.profiles[profileName]?.initialization_command ?? topInit)
				: topInit;
			return [
				profileName ?? '',
				JSON.stringify({flags, resume: agent.resumeArgs, init}),
			];
		}),
	);
}

function changedProfile(
	before: Record<string, string>,
	after: Record<string, string>,
): string | undefined {
	return Object.keys(before).find(name => before[name] !== after[name]);
}

/**
 * Plan the rewrite of every config file still on the old `claude:` format.
 * The plan is only ready when the rewritten config launches every space
 * exactly as the current one does.
 */
export function planConfigMigrations(
	paths: ConfigPaths = defaultConfigPaths(),
): ConfigMigrationPlan {
	let files: LayerFile[];
	let whole: PappardelleConfig;
	try {
		files = configLayerFiles(paths).flatMap(({label, path: filePath}) => {
			if (!filePath) return [];
			const content = fs.readFileSync(filePath, 'utf8');
			return [
				{
					label,
					path: filePath,
					content,
					layer: parseConfigLayer(label, content),
				},
			];
		});
		whole = buildConfigFromLayers(
			files.map(({label, layer}) => ({
				label,
				layer: layer && structuredClone(layer),
			})),
		);
	} catch {
		// Loading reports a broken config on its own.
		return {kind: 'none'};
	}

	if (
		!files.some(
			({layer}) => layer && findDeprecatedClaudeFields(layer).length > 0,
		)
	) {
		return {kind: 'none'};
	}

	try {
		return planRewrite(files, whole);
	} catch (error) {
		return {
			kind: 'unsupported',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function planRewrite(
	files: LayerFile[],
	whole: PappardelleConfig,
): ConfigMigrationPlan {
	const multiLine = multiLineExtraArg(files);
	if (multiLine) return {kind: 'unsupported', reason: multiLine};
	const repeated = repeatedLaunchFlag(whole);
	if (repeated) return {kind: 'unsupported', reason: repeated};
	const migrations: ConfigMigration[] = [];
	const rewritten = files.map((file, index) => {
		if (!file.layer) return file;
		const content = migrateLayer(
			file as LayerFile & {layer: Fields},
			layersUpTo(files, index),
			whole,
			new Set(
				files
					.slice(0, index)
					.flatMap(({layer}) => (layer ? profilesWithLaunchFields(layer) : [])),
			),
		);
		if (content === file.content) return file;
		migrations.push({
			label: file.label,
			displayPath: displayPath(file.path),
			path: file.path,
			content,
		});
		return {...file, content, layer: parseConfigLayer(file.label, content)};
	});

	let after: PappardelleConfig;
	try {
		after = buildConfigFromLayers(
			rewritten.map(({label, layer}) => ({label, layer})),
		);
	} catch (error) {
		return {
			kind: 'unsupported',
			reason: `the rewritten config doesn't load: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const leftover = rewritten.find(
		({layer}) => layer && findDeprecatedClaudeFields(layer).length > 0,
	);
	if (leftover) {
		return {
			kind: 'unsupported',
			reason: `${leftover.label} has a claude: setting that can't be moved`,
		};
	}

	const changed = changedProfile(launches(whole), launches(after));
	if (changed !== undefined) {
		return {
			kind: 'unsupported',
			reason: changed
				? `the rewrite would change how profile "${changed}" launches`
				: 'the rewrite would change how spaces without a profile launch',
		};
	}

	return {
		kind: 'ready',
		migrations,
		renames: agentProfileRenames(whole, after),
	};
}

function agentProfileRenames(
	before: PappardelleConfig,
	after: PappardelleConfig,
): AgentProfileRename[] {
	return [undefined, ...Object.keys(before.profiles)].flatMap(profileName => {
		const from = resolveAgentProfileName(before, undefined, profileName);
		const to = resolveAgentProfileName(after, undefined, profileName);
		return from === to ? [] : [{profileName, from, to}];
	});
}

/**
 * Session ids are recorded per agent profile name, so a space whose profile
 * moved to a new agent profile would relaunch without resuming its
 * conversation. Its id moves to the new name.
 */
export function moveAgentSessions(
	renames: AgentProfileRename[],
	stateDir: string,
): void {
	if (renames.length === 0) return;
	let files: string[];
	try {
		files = fs.readdirSync(stateDir);
	} catch {
		return;
	}

	for (const file of files) {
		const key = file.endsWith('.agent-sessions.json')
			? file.slice(0, -'.agent-sessions.json'.length)
			: undefined;
		if (!key) continue;
		const profileName = savedProfile(stateDir, key);
		// Only the main space launches without a profile. Another space without
		// a saved one predates saving it, so its profile isn't known.
		if (profileName === undefined && key !== MAIN_WORKTREE_KEY) continue;
		const rename = renames.find(rename => rename.profileName === profileName);
		if (rename) moveAgentSession(path.join(stateDir, file), rename);
	}
}

function savedProfile(stateDir: string, key: string): string | undefined {
	try {
		const state = asFields(
			JSON.parse(fs.readFileSync(path.join(stateDir, `${key}.json`), 'utf8')),
		);
		const profile = state?.['profile'];
		return typeof profile === 'string' ? profile : undefined;
	} catch {
		return undefined;
	}
}

function moveAgentSession(file: string, {from, to}: AgentProfileRename) {
	try {
		const sessions = asFields(JSON.parse(fs.readFileSync(file, 'utf8')));
		if (!sessions || !(from in sessions) || to in sessions) return;
		const moved = Object.fromEntries(
			Object.entries(sessions).map(([name, entry]) => [
				name === from ? to : name,
				entry,
			]),
		);
		const temporary = `${file}.tmp.${process.pid}`;
		fs.writeFileSync(temporary, JSON.stringify(moved, null, 2) + '\n');
		fs.renameSync(temporary, file);
	} catch {
		// The space relaunches with --continue instead.
	}
}

/**
 * Write every file, or none if any can't be written: a half-migrated config
 * resolves differently from both the old and the new one. A symlinked config
 * (a dotfiles checkout) is rewritten at its target so the link survives, and
 * each file keeps its permissions; a read-only one is refused.
 */
export function applyConfigMigrations(migrations: ConfigMigration[]): void {
	const staged: Array<{target: string; temporary: string}> = [];
	try {
		for (const {path: filePath, content} of migrations) {
			const target = fs.realpathSync(filePath);
			fs.accessSync(target, fs.constants.W_OK);
			const temporary = path.join(
				path.dirname(target),
				`.${path.basename(target)}.pappardelle-migration`,
			);
			const {mode} = fs.statSync(target);
			fs.writeFileSync(temporary, content);
			// The umask applies to a create mode, and a leftover temporary keeps its own.
			fs.chmodSync(temporary, mode);
			staged.push({target, temporary});
		}
	} catch (error) {
		for (const {temporary} of staged) fs.rmSync(temporary, {force: true});
		throw error;
	}

	for (const {target, temporary} of staged) {
		fs.renameSync(temporary, target);
	}

	dismissDeprecationWarnings();
}

export type ConfigMigrationOutcome =
	| {kind: 'rewritten'}
	/** The files no longer need the rewrite the user approved; nothing was written. */
	| {kind: 'changed'}
	| {kind: 'failed'; reason: string};

/**
 * Carry out a rewrite the user approved. It is planned again first, since
 * the files may have been edited while the dialog was open: the approved
 * plan would overwrite those edits, and a new plan may cover files the user
 * was never shown.
 */
export function confirmConfigMigrations(
	approved: ConfigMigration[],
	stateDir: string,
	paths: ConfigPaths = defaultConfigPaths(),
): ConfigMigrationOutcome {
	const plan = planConfigMigrations(paths);
	if (plan.kind === 'unsupported') return {kind: 'failed', reason: plan.reason};
	const filesOf = (migrations: ConfigMigration[]) =>
		migrations.map(m => m.path).join('\n');
	if (plan.kind === 'none' || filesOf(plan.migrations) !== filesOf(approved)) {
		dismissResolvedDeprecationWarnings(paths);
		return {kind: 'changed'};
	}

	try {
		applyConfigMigrations(plan.migrations);
		moveAgentSessions(plan.renames, stateDir);
		return {kind: 'rewritten'};
	} catch (error) {
		return {
			kind: 'failed',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Clear the warnings for whatever the files no longer use, however that came
 * about (Claude, or an edit by hand). True once none are left.
 */
export function dismissResolvedDeprecationWarnings(
	paths: ConfigPaths = defaultConfigPaths(),
): boolean {
	let remaining: string[];
	try {
		remaining = configLayerFiles(paths).flatMap(({label, path: filePath}) => {
			if (!filePath) return [];
			const layer = parseConfigLayer(label, fs.readFileSync(filePath, 'utf8'));
			return layer ? deprecationWarnings(layer, label) : [];
		});
	} catch {
		// A file that no longer parses: nothing is known to be resolved.
		return false;
	}

	dismissDeprecationWarnings(new Set(remaining));
	return remaining.length === 0;
}

export function buildConfigMigrationConfirmContent(
	migrations: ConfigMigration[],
) {
	const rewritesHome = migrations.some(m => m.label === HOME_LABEL);
	return {
		title: 'Update Config Format',
		message:
			'Your config uses deprecated claude: settings that agent profiles replaced. Rewrite it to the new format?',
		detail: [
			`Rewrites ${migrations.map(m => m.displayPath).join(', ')}, keeping comments and formatting.`,
			// Each file's agent profiles get the values they launched with, and
			// some of those came from the home config.
			rewritesHome && migrations.some(m => m.label === PROJECT_LABEL)
				? `Settings from ${HOME_LABEL} are copied into ${PROJECT_LABEL} so every profile launches as it does now. That file is usually committed, so check the diff before you share it.`
				: '',
			// An agent profile's own model or effort beats the claude.* fallback
			// of a repo still on the old format, and that repo's rewrite then
			// compares against the changed launch.
			rewritesHome
				? `${HOME_LABEL} is shared by every repo. A repo still on the old format stops using its own claude.model and claude.effort wherever the rewritten home config sets them, and rewriting that repo later won't bring them back.`
				: '',
		]
			.filter(Boolean)
			.join(' '),
		processingMessage: 'Rewriting config…',
	};
}

export function buildConfigFixConfirmContent(reason: string) {
	return {
		title: 'Config Not Rewritten',
		message: `Pappardelle couldn't rewrite your config to the agent-profile format: ${reason}. Ask Claude to fix it?`,
		detail: 'Opens claude in a popup with a prompt describing the change.',
	};
}

/** The prompt that hands a failed rewrite to Claude, self-contained. */
export function buildConfigFixPrompt(
	reason: string,
	paths: ConfigPaths = defaultConfigPaths(),
): string {
	const files = configLayerFiles(paths).filter(
		(file): file is {label: string; path: string} => Boolean(file.path),
	);
	const warnings = files.flatMap(({label, path: filePath}) => {
		try {
			const layer = parseConfigLayer(label, fs.readFileSync(filePath, 'utf8'));
			return layer ? deprecationWarnings(layer, label) : [];
		} catch {
			return [];
		}
	});
	return [
		`My pappardelle config still uses deprecated claude: settings, and pappardelle couldn't rewrite it automatically: ${reason}.`,
		'',
		[
			'Config files, lowest priority first; they deep-merge in this order',
			files.some(({label}) => label === HOME_LABEL)
				? `, and ${HOME_LABEL} is shared by every repo:`
				: ':',
		].join(''),
		...files.map(({label, path: filePath}) => `- ${filePath} (${label})`),
		'',
		'Deprecation warnings:',
		...warnings.map(warning => `- ${warning}`),
		'',
		'Rewrite them so no claude.initialization_command, claude.model, claude.effort or claude.extra_args remain, and every profile launches with exactly the same command, args, model, effort and initial prompt as today:',
		'- claude.initialization_command becomes initialization_command at the same level',
		'- a space launches the agent profile its profile selects (profiles.<name>.agent_profile, else the top-level agent_profile, else the built-in claude agent profile `command: claude`)',
		"- an agent profile's own model/effort always win, an empty string included; claude.model/effort only fill in for claude agent profiles (command claude, or is_claude: true) that leave them unset, and other CLIs never read them",
		"- profiles.<name>.claude.* beat the top-level claude.* for that profile; extra_args (profile list over top-level list) are appended after the agent profile's args and after the flags rendered from model/effort, so an extra arg repeating --model or --effort wins today; keep that value",
		"- if part of it can't be kept exactly (for example an extra arg spanning several lines, since args are one line), stop and ask me how to handle that part rather than change the launch",
		"- to move a profile's claude.* values, copy the agent profile it launches today (command, args, resume_args, model_args, effort_args, is_claude) into a new entry under agent_profiles, add the values to it, and select it with profiles.<name>.agent_profile",
		'- keep comments and formatting',
	].join('\n');
}
