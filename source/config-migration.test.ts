import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {parse, stringify} from 'yaml';
import {
	getAgentProfile,
	getInitializationCommand,
	loadConfigFromPaths,
	type ConfigPaths,
	type PappardelleConfig,
} from './config.ts';
import {findDeprecatedClaudeFields} from './config-deprecation.ts';
import {renderAgentLaunchFlags} from './config-launch-flags.ts';
import {
	applyConfigMigrations,
	buildConfigMigrationConfirmContent,
	confirmConfigMigrations,
	dismissResolvedDeprecationWarnings,
	planConfigMigrations,
	runConfigFix,
	type ConfigMigration,
} from './config-migration.ts';
import {getRecentErrors} from './logger.ts';
import {getSpaceStateDir} from './space-state.ts';
import {testState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

/** A repo where no space has saved a profile or recorded a session. */
const noSpaces = {read: () => null, async write() {}};
const noSessions = {keys: () => [], async renameProfile() {}};

function writeConfig(dir: string, file: string, config: unknown) {
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(
		path.join(dir, file),
		typeof config === 'string' ? config : stringify(config),
	);
}

function setup(
	home: unknown,
	project?: unknown,
	local?: unknown,
): Required<Pick<ConfigPaths, 'homeConfigDir' | 'projectDir'>> {
	const root = tempDir('config-migration-');
	const homeConfigDir = path.join(root, 'home');
	const projectDir = path.join(root, 'project');
	fs.mkdirSync(projectDir);
	if (home) writeConfig(homeConfigDir, '.pappardelle.yml', home);
	if (project) writeConfig(projectDir, '.pappardelle.yml', project);
	if (local) writeConfig(projectDir, '.pappardelle.local.yml', local);
	return {homeConfigDir, projectDir};
}

// Flag order isn't preserved: extra_args moves into args, ahead of the
// model/effort flags, which no CLI cares about.
function launches(config: PappardelleConfig) {
	return Object.fromEntries(
		[undefined, ...Object.keys(config.profiles)].map(name => {
			const agent = getAgentProfile(config, undefined, name);
			return [
				name ?? '(none)',
				`${agent.command} ${agent.args}${renderAgentLaunchFlags(agent)}`
					.split(/\s+/)
					.filter(Boolean)
					.sort(),
			];
		}),
	);
}

function readyMigrations(paths: ConfigPaths): ConfigMigration[] {
	const plan = planConfigMigrations(paths);
	if (plan.kind !== 'ready') throw new Error(`plan is ${JSON.stringify(plan)}`);
	return plan.migrations;
}

function migrate(paths: ConfigPaths): ConfigMigration[] {
	const migrations = readyMigrations(paths);
	applyConfigMigrations(migrations);
	return migrations;
}

test('every profile launches the same way after the rewrite', () => {
	const paths = setup(
		{
			version: 1,
			claude: {
				initialization_command: '/idow',
				model: 'opus',
				effort: 'high',
				extra_args: ['--no-chrome'],
				dangerously_skip_permissions: true,
			},
			agent_profiles: {
				codex: {command: 'codex', args: '--yolo', model: 'gpt-5'},
				'opus-max': {command: 'claude', effort: 'max'},
			},
			profiles: {
				plain: {display_name: 'Plain'},
				codexed: {display_name: 'Codexed', agent_profile: 'codex'},
				max: {display_name: 'Max', agent_profile: 'opus-max'},
				sonnet: {
					display_name: 'Sonnet',
					claude: {model: 'sonnet', extra_args: ['--tools', 'Read Edit']},
				},
				ignored: {
					display_name: 'Ignored',
					agent_profile: 'codex',
					claude: {model: 'sonnet'},
				},
			},
		},
		{
			version: 1,
			claude: {model: 'haiku'},
			profiles: {
				project: {
					display_name: 'Project',
					claude: {initialization_command: '/plan', effort: 'low'},
				},
			},
		},
	);
	const before = loadConfigFromPaths(paths);

	const migrations = migrate(paths);

	expect(migrations.length).toBe(2);
	const after = loadConfigFromPaths(paths);
	expect(launches(after)).toStrictEqual(launches(before));
	expect(getInitializationCommand(after)).toBe('idow');
	expect(after.profiles['project']!.initialization_command).toBe('plan');
	expect(after.claude?.dangerously_skip_permissions).toBe(true);
	for (const {path: file} of migrations) {
		const layer = parse(fs.readFileSync(file, 'utf8')) as Record<
			string,
			unknown
		>;
		expect(findDeprecatedClaudeFields(layer)).toStrictEqual([]);
	}

	expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
});

test('the shared home config never takes on one repo’s settings', () => {
	const home = {
		version: 1,
		claude: {model: 'opus', extra_args: ['--verbose']},
		profiles: {x: {display_name: 'X', claude: {effort: 'low'}}},
	};
	const repoP = setup(home, {
		version: 1,
		claude: {extra_args: ['--foo']},
		agent_profiles: {'opus-max': {command: 'claude', effort: 'max'}},
		profiles: {},
	});
	const repoQ = {
		...setup(undefined, {version: 1, profiles: {}}),
		homeConfigDir: repoP.homeConfigDir,
	};
	const beforeP = launches(loadConfigFromPaths(repoP));
	const beforeQ = launches(loadConfigFromPaths(repoQ));

	migrate(repoP);

	expect(launches(loadConfigFromPaths(repoP))).toStrictEqual(beforeP);
	expect(launches(loadConfigFromPaths(repoQ))).toStrictEqual(beforeQ);
});

test('extra args survive a higher file that sets the agent profile’s args', () => {
	const paths = setup(
		{
			version: 1,
			claude: {extra_args: ['--verbose']},
			agent_profiles: {opus: {command: 'claude', args: '--home'}},
			profiles: {p: {display_name: 'P', agent_profile: 'opus'}},
		},
		{version: 1, agent_profiles: {opus: {args: '--foo'}}, profiles: {}},
	);
	const before = launches(loadConfigFromPaths(paths));

	migrate(paths);

	expect(launches(loadConfigFromPaths(paths))).toStrictEqual(before);
});

test('a block-scalar args value still loads once extra args join it', () => {
	const paths = setup(
		[
			'version: 1',
			'claude:',
			'  extra_args: [--verbose]',
			'agent_profiles:',
			'  opus:',
			'    command: claude',
			'    args: >',
			'      --foo',
			'profiles:',
			'  p: {display_name: P, agent_profile: opus}',
			'',
		].join('\n'),
	);
	const before = launches(loadConfigFromPaths(paths));

	migrate(paths);

	expect(launches(loadConfigFromPaths(paths))).toStrictEqual(before);
});

test('an agent profile named like the generated one is left alone', () => {
	const paths = setup({
		version: 1,
		agent_profiles: {'work-claude': {command: 'codex'}},
		profiles: {work: {display_name: 'Work', claude: {model: 'opus'}}},
	});
	const before = launches(loadConfigFromPaths(paths));

	migrate(paths);

	const after = loadConfigFromPaths(paths);
	expect(after.agent_profiles?.['work-claude']).toStrictEqual({
		command: 'codex',
	});
	expect(after.profiles['work']!.agent_profile).toBe('work-claude-2');
	expect(launches(after)).toStrictEqual(before);
});

test('no rewrite is offered when a higher file would undo it', () => {
	const paths = setup(
		{
			version: 1,
			agent_profiles: {fast: {command: 'claude'}},
			profiles: {},
		},
		{
			version: 1,
			profiles: {foo: {display_name: 'Foo', claude: {model: 'opus'}}},
		},
		{version: 1, profiles: {foo: {agent_profile: 'fast'}}},
	);

	expect(planConfigMigrations(paths)).toMatchObject({kind: 'unsupported'});
});

test('comments and untouched keys keep their formatting', () => {
	const paths = setup(
		[
			'# my config',
			'version: 1',
			`docs: "https://example.com/${'a'.repeat(100)}"`,
			'claude:',
			'  model: opus # the big one',
			'  dangerously_skip_permissions: true',
			'profiles:',
			'  plain: {display_name: "Plain"}',
			'',
		].join('\n'),
	);

	migrate(paths);

	expect(
		fs.readFileSync(path.join(paths.homeConfigDir, '.pappardelle.yml'), 'utf8'),
	).toBe(
		[
			'# my config',
			'version: 1',
			`docs: "https://example.com/${'a'.repeat(100)}"`,
			'claude:',
			'  dangerously_skip_permissions: true',
			'profiles:',
			'  plain: {display_name: "Plain"}',
			'agent_profiles:',
			'  claude:',
			'    command: claude',
			'    # the big one',
			'    model: opus',
			'',
		].join('\n'),
	);
});

test('comments on moved keys follow them, and a header above claude: stays', () => {
	const paths = setup(
		[
			'# home config',
			'claude:',
			'  # why opus',
			'  model: opus',
			'  initialization_command: "/idow" # kick off',
			'version: 1',
			'profiles: {}',
			'',
		].join('\n'),
	);

	migrate(paths);

	expect(
		fs.readFileSync(path.join(paths.homeConfigDir, '.pappardelle.yml'), 'utf8'),
	).toBe(
		[
			'# home config',
			'version: 1',
			'profiles: {}',
			'# kick off',
			'initialization_command: "idow"',
			'agent_profiles:',
			'  claude:',
			'    command: claude',
			'    # why opus',
			'    model: opus',
			'',
		].join('\n'),
	);
});

test('an initialization_command written with its skill prefix loses it', () => {
	const paths = setup(
		[
			'version: 1',
			"initialization_command: '/idow' # kick off",
			'profiles:',
			'  api:',
			'    display_name: Api',
			'    initialization_command: /plan',
			'',
		].join('\n'),
	);

	migrate(paths);

	expect(
		fs.readFileSync(path.join(paths.homeConfigDir, '.pappardelle.yml'), 'utf8'),
	).toBe(
		[
			'version: 1',
			"initialization_command: 'idow' # kick off",
			'profiles:',
			'  api:',
			'    display_name: Api',
			'    initialization_command: plan',
			'',
		].join('\n'),
	);
	expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
});

test('dropping a skill prefix in the home config warns about nothing it doesn’t move', () => {
	const paths = setup({
		version: 1,
		initialization_command: '/idow',
		profiles: {plain: {display_name: 'Plain'}},
	});

	const {detail} = buildConfigMigrationConfirmContent(readyMigrations(paths));

	expect(detail.includes('shared by every repo')).toBe(false);
});

test('a config on the current format needs no rewrite', () => {
	const paths = setup({
		version: 1,
		initialization_command: 'idow',
		agent_profiles: {claude: {command: 'claude', model: 'opus'}},
		profiles: {plain: {display_name: 'Plain'}},
	});

	expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
});

test('no rewrite is offered for a project config that sets experimental.sqliteState', () => {
	const paths = setup(undefined, {
		version: 1,
		experimental: {sqliteState: true},
		claude: {model: 'opus'},
		profiles: {plain: {display_name: 'Plain'}},
	});

	expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
});

test('the rewrite clears the deprecation warnings from the error pane', () => {
	const paths = setup({
		version: 1,
		claude: {effort: 'xhigh'},
		profiles: {plain: {display_name: 'Plain'}},
	});
	const isWarning = () =>
		getRecentErrors().some(entry =>
			entry.message.includes('claude.effort is deprecated'),
		);
	loadConfigFromPaths(paths);
	expect(isWarning()).toBe(true);

	migrate(paths);

	expect(isWarning()).toBe(false);
});

test('no file is rewritten when any of them cannot be written', () => {
	const paths = setup(
		{version: 1, claude: {model: 'opus'}, profiles: {}},
		{version: 1, claude: {effort: 'low'}, profiles: {}},
	);
	const migrations = readyMigrations(paths);
	const homeFile = path.join(paths.homeConfigDir, '.pappardelle.yml');
	const original = fs.readFileSync(homeFile, 'utf8');
	fs.chmodSync(paths.projectDir, 0o555);
	try {
		expect(() => {
			applyConfigMigrations(migrations);
		}).toThrow();
	} finally {
		fs.chmodSync(paths.projectDir, 0o755);
	}

	expect(fs.readFileSync(homeFile, 'utf8')).toBe(original);
	expect(fs.readdirSync(paths.homeConfigDir)).toStrictEqual([
		'.pappardelle.yml',
	]);
});

for (const [name, home, project] of [
	['top-level model', {claude: {model: 'opus'}}, {claude: {model: ''}}],
	[
		'profile model',
		{profiles: {p: {display_name: 'P', claude: {model: 'opus'}}}},
		{profiles: {p: {claude: {model: ''}}}},
	],
	[
		'profile extra args',
		{profiles: {p: {display_name: 'P', claude: {extra_args: ['--verbose']}}}},
		{profiles: {p: {claude: {extra_args: []}}}},
	],
] as const) {
	test(`a higher file's empty ${name} still clears the one beneath it`, () => {
		const paths = setup(
			{version: 1, profiles: {}, ...home},
			{version: 1, profiles: {}, ...project},
		);
		const before = launches(loadConfigFromPaths(paths));

		migrate(paths);

		expect(launches(loadConfigFromPaths(paths))).toStrictEqual(before);
	});
}

test('YAML aliases make the rewrite unsupported rather than throw', () => {
	const paths = setup(
		[
			'version: 1',
			'claude: &base {model: opus}',
			'profiles:',
			'  p: {display_name: P, claude: *base}',
			'',
		].join('\n'),
	);

	expect(planConfigMigrations(paths)).toMatchObject({kind: 'unsupported'});
});

test('a symlinked config is rewritten at its target with its permissions', () => {
	const paths = setup(undefined, {version: 1, profiles: {}});
	const dotfiles = path.join(tempDir('config-migration-'), 'pappardelle.yml');
	fs.writeFileSync(dotfiles, stringify({version: 1, claude: {model: 'opus'}}));
	fs.chmodSync(dotfiles, 0o664);
	fs.mkdirSync(paths.homeConfigDir, {recursive: true});
	const link = path.join(paths.homeConfigDir, '.pappardelle.yml');
	fs.symlinkSync(dotfiles, link);

	migrate(paths);

	expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	expect(
		findDeprecatedClaudeFields(
			parse(fs.readFileSync(dotfiles, 'utf8')) as Record<string, unknown>,
		),
	).toStrictEqual([]);
	expect((fs.statSync(dotfiles).mode % 0o1000).toString(8)).toBe('664');
});

test('a read-only config is not rewritten', () => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const file = path.join(paths.homeConfigDir, '.pappardelle.yml');
	const original = fs.readFileSync(file, 'utf8');
	fs.chmodSync(file, 0o444);

	expect(() => {
		applyConfigMigrations(readyMigrations(paths));
	}).toThrow();
	expect(fs.readFileSync(file, 'utf8')).toBe(original);
});

test('warnings clear once the old keys are gone, even by hand', () => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const isWarning = () =>
		getRecentErrors().some(entry =>
			entry.message.includes('claude.model is deprecated'),
		);
	loadConfigFromPaths(paths);
	dismissResolvedDeprecationWarnings(paths);
	expect(isWarning()).toBe(true);

	writeConfig(paths.homeConfigDir, '.pappardelle.yml', {
		version: 1,
		profiles: {},
	});
	dismissResolvedDeprecationWarnings(paths);

	expect(isWarning()).toBe(false);
});

test('confirming rewrites the files the user was shown', async () => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const approved = readyMigrations(paths);

	expect(
		await confirmConfigMigrations(approved, noSessions, noSpaces, paths),
	).toStrictEqual({
		kind: 'rewritten',
	});
	expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
});

test('a space whose profile moves to a new agent profile keeps its session id', async () => {
	const paths = setup({
		version: 1,
		profiles: {
			alpha: {display_name: 'Alpha', claude: {model: 'opus'}},
			beta: {display_name: 'Beta'},
		},
	});
	const state = testState();
	const stateDir = getSpaceStateDir('repo', state.stateDir);
	fs.mkdirSync(stateDir, {recursive: true});
	const space = (key: string, profile: string | undefined) => {
		if (profile) {
			fs.writeFileSync(
				path.join(stateDir, `${key}.json`),
				JSON.stringify({
					profile,
					agentProfile: {name: 'claude', isClaude: true},
				}),
			);
		}

		fs.writeFileSync(
			path.join(stateDir, `${key}.agent-sessions.json`),
			JSON.stringify({claude: {session_id: `${key}-id`, pid: 1}}),
		);
		return () =>
			JSON.parse(
				fs.readFileSync(
					path.join(stateDir, `${key}.agent-sessions.json`),
					'utf8',
				),
			) as Record<string, {session_id: string}>;
	};

	const alpha = space('A-1', 'alpha');
	const beta = space('B-1', 'beta');
	const unknown = space('U-1', undefined);
	const main = space('main', undefined);

	expect(
		await confirmConfigMigrations(
			readyMigrations(paths),
			state.daos.agentSessions,
			state.daos.spaceState,
			paths,
		),
	).toStrictEqual({kind: 'rewritten'});
	expect(Object.keys(alpha())).toStrictEqual(['alpha-claude']);
	expect(alpha()['alpha-claude']?.session_id).toBe('A-1-id');
	expect(Object.keys(beta())).toStrictEqual(['claude']);
	expect(Object.keys(unknown())).toStrictEqual(['claude']);
	expect(Object.keys(main())).toStrictEqual(['claude']);
	expect(state.daos.spaceState.read('A-1')?.agentProfile).toStrictEqual({
		name: 'alpha-claude',
		isClaude: true,
	});
	expect(state.daos.spaceState.read('B-1')?.agentProfile?.name).toBe('claude');
});

test('confirming keeps edits made while the dialog was open', async () => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const approved = readyMigrations(paths);
	writeConfig(paths.homeConfigDir, '.pappardelle.yml', {
		version: 1,
		claude: {model: 'opus'},
		profiles: {added: {display_name: 'Added'}},
	});

	expect(
		await confirmConfigMigrations(approved, noSessions, noSpaces, paths),
	).toStrictEqual({
		kind: 'rewritten',
	});
	expect(loadConfigFromPaths(paths).profiles['added']).toBeTruthy();
});

test('confirming writes nothing once the rewrite covers files the user was not shown', async () => {
	const paths = setup(
		{version: 1, profiles: {}},
		{version: 1, profiles: {b: {display_name: 'B', claude: {effort: 'low'}}}},
	);
	const approved = readyMigrations(paths);
	const homeFile = path.join(paths.homeConfigDir, '.pappardelle.yml');
	writeConfig(paths.homeConfigDir, '.pappardelle.yml', {
		version: 1,
		claude: {effort: 'max'},
		profiles: {},
	});
	const edited = fs.readFileSync(homeFile, 'utf8');

	expect(
		await confirmConfigMigrations(approved, noSessions, noSpaces, paths),
	).toStrictEqual({
		kind: 'changed',
	});
	expect(fs.readFileSync(homeFile, 'utf8')).toBe(edited);
});

test('confirming reports a failed write so it can be handed to Claude', async () => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const approved = readyMigrations(paths);
	fs.chmodSync(path.join(paths.homeConfigDir, '.pappardelle.yml'), 0o444);

	expect(
		await confirmConfigMigrations(approved, noSessions, noSpaces, paths),
	).toMatchObject({
		kind: 'failed',
	});
});

test('a multi-line extra arg is named as the reason it cannot be rewritten', () => {
	const paths = setup({
		version: 1,
		claude: {extra_args: ['--append-system-prompt', 'line one\nline two']},
		profiles: {},
	});

	expect(planConfigMigrations(paths)).toStrictEqual({
		kind: 'unsupported',
		reason:
			"~/.pappardelle/.pappardelle.yml: claude.extra_args has a multi-line value, and an agent profile's args must fit on one line",
	});
});

test('an extra arg repeating the model flag blocks the rewrite', () => {
	const paths = setup({
		version: 1,
		claude: {model: 'opus', extra_args: ['--model', 'sonnet']},
		profiles: {},
	});

	expect(planConfigMigrations(paths)).toStrictEqual({
		kind: 'unsupported',
		reason:
			'claude.extra_args repeats --model, and the rewrite would change which model wins at the top level',
	});
});

test('an extra arg repeating a model flag written with = blocks the rewrite', () => {
	const paths = setup({
		version: 1,
		agent_profiles: {
			wrapper: {
				command: 'my-claude',
				is_claude: true,
				model_args: '--model={model}',
			},
		},
		agent_profile: 'wrapper',
		claude: {model: 'opus', extra_args: ['--model=sonnet']},
		profiles: {},
	});

	expect(planConfigMigrations(paths)).toMatchObject({
		reason:
			'claude.extra_args repeats --model, and the rewrite would change which model wins at the top level',
	});
});

test('an end-of-options marker in extra args blocks the rewrite', () => {
	const paths = setup({
		version: 1,
		claude: {model: 'opus', extra_args: ['--verbose', '--']},
		profiles: {},
	});

	expect(planConfigMigrations(paths)).toMatchObject({
		reason:
			'claude.extra_args has --, and the rewrite would put the model flag at the top level after it',
	});
});

test('a partial fix clears the warnings for the keys that are gone', () => {
	const paths = setup(
		{version: 1, claude: {model: 'opus'}, profiles: {}},
		{version: 1, claude: {effort: 'low'}, profiles: {}},
	);
	const isWarning = (field: string) =>
		getRecentErrors().some(entry =>
			entry.message.includes(`claude.${field} is deprecated`),
		);
	loadConfigFromPaths(paths);
	writeConfig(paths.projectDir, '.pappardelle.yml', {version: 1, profiles: {}});

	expect(dismissResolvedDeprecationWarnings(paths)).toBe(false);

	expect(isWarning('model')).toBe(true);
	expect(isWarning('effort')).toBe(false);
});

// The agy workaround from before prompt_args, in a dotfiles-style file.
const AGY_WORKAROUND = `version: 1
agent_profiles:
  # Prompt goes in through -i
  'argon:medium': {command: agy, model: gemini-4-argon-medium, model_args: '--model {model} -i'}
  'argon:high': {command: agy, model: gemini-4-argon, effort: high, model_args: '--model {model} -i', effort_args: '--effort {effort} -i'}
  'codex:medium': {command: codex, model: gpt-6, effort: medium, model_args: '-m {model}', resume_args: 'resume {session_id}'}
  aider: {command: aider, model: sonnet, model_args: '--model {model}'}
profiles:
  argon: {display_name: Argon, agent_profile: 'argon:medium'}
  argon-high: {display_name: Argon high, agent_profile: 'argon:high'}
`;

test('agy profiles lose the -i workaround and built-in agents their default fields', () => {
	const paths = setup(AGY_WORKAROUND);

	const migrations = migrate(paths);

	expect(migrations[0]!.removesBuiltinDefaults).toBe(true);
	expect(fs.readFileSync(migrations[0]!.path, 'utf8')).toBe(`version: 1
agent_profiles:
  # Prompt goes in through -i
  'argon:medium': {command: agy, model: gemini-4-argon-medium}
  'argon:high': {command: agy, model: gemini-4-argon, effort: high}
  'codex:medium': {command: codex, model: gpt-6, effort: medium}
  aider: {command: aider, model: sonnet, model_args: '--model {model}'}
profiles:
  argon: {display_name: Argon, agent_profile: 'argon:medium'}
  argon-high: {display_name: Argon high, agent_profile: 'argon:high'}
`);
	expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
});

test('the -i workaround is offered with a warning naming the field', () => {
	const paths = setup(AGY_WORKAROUND);
	loadConfigFromPaths(paths);

	expect(
		getRecentErrors().some(({message}) =>
			message.includes(
				'agent_profiles.argon:medium.model_args ends with -i, which the built-in prompt_args now adds',
			),
		),
	).toBe(true);
	expect(
		buildConfigMigrationConfirmContent(readyMigrations(paths)),
	).toMatchObject({
		detail:
			'Rewrites ' +
			readyMigrations(paths)[0]!.displayPath +
			', keeping comments and formatting. Agent profile fields that codex, agy and claude now get built in are removed, along with the -i at the end of an agy model_args or effort_args.',
	});
});

test('fields that only repeat a built-in default never prompt a rewrite on their own', () => {
	const paths = setup({
		version: 1,
		agent_profiles: {
			codex: {command: 'codex', resume_args: 'resume {session_id}'},
		},
		profiles: {},
	});

	expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
});

test('a default-valued field stays when a lower file sets it differently', () => {
	const paths = setup(
		{
			version: 1,
			agent_profiles: {codex: {command: 'codex', resume_args: ''}},
			profiles: {},
		},
		{
			version: 1,
			agent_profiles: {
				codex: {resume_args: 'resume {session_id}'},
				argon: {command: 'agy', model_args: '--model {model} -i'},
			},
			profiles: {},
		},
	);

	migrate(paths);

	const after = loadConfigFromPaths(paths);
	expect(after.agent_profiles?.['codex']?.resume_args).toBe(
		'resume {session_id}',
	);
	expect(after.agent_profiles?.['argon']?.model_args).toBe(undefined);
});

test('a default-valued field stays when a higher file changes the command', () => {
	const paths = setup(
		{
			version: 1,
			agent_profiles: {
				x: {command: 'codex', model: 'm', model_args: '-m {model}'},
				argon: {command: 'agy', model_args: '--model {model} -i'},
			},
			profiles: {},
		},
		{version: 1, agent_profiles: {x: {command: 'aider'}}, profiles: {}},
	);

	migrate(paths);

	expect(loadConfigFromPaths(paths).agent_profiles?.['x']?.model_args).toBe(
		'-m {model}',
	);
});

for (const [name, override] of [
	['changes the command', {command: 'gemini'}],
	['sets prompt_args', {prompt_args: '--prompt {prompt}'}],
] as const) {
	test(`a trailing -i stays when a higher file ${name}`, () => {
		const paths = setup(
			{
				version: 1,
				agent_profiles: {
					argon: {command: 'agy', model: 'g', model_args: '--model {model} -i'},
				},
				profiles: {},
			},
			undefined,
			{version: 1, agent_profiles: {argon: override}, profiles: {}},
		);

		loadConfigFromPaths(paths);

		expect(planConfigMigrations(paths)).toStrictEqual({kind: 'none'});
		expect(
			getRecentErrors().some(({message}) => message.includes('ends with -i')),
		).toBe(false);
	});
}

test('a trailing -i is found in a file that sets only model_args', () => {
	const paths = setup(
		{
			version: 1,
			agent_profiles: {argon: {command: 'agy', model: 'g'}},
			profiles: {},
		},
		undefined,
		{
			version: 1,
			agent_profiles: {argon: {model_args: '--model {model} -i'}},
			profiles: {},
		},
	);

	migrate(paths);

	expect(loadConfigFromPaths(paths).agent_profiles?.['argon']?.model_args).toBe(
		undefined,
	);
});

test("a rewrite that would drop an agent profile's env from a higher layer is unsupported", () => {
	const paths = setup(
		null,
		{
			version: 1,
			profiles: {ws: {display_name: 'W', claude: {model: 'opus'}}},
		},
		{agent_profiles: {claude: {command: 'claude', env: {CODE_MODE: '1'}}}},
	);

	expect(planConfigMigrations(paths)).toMatchObject({kind: 'unsupported'});
});

/** Runs a fix command with a stub claude that records the arguments it gets. */
function stubClaude() {
	const bin = tempDir('config-fix-bin-');
	const argsFile = path.join(bin, 'args');
	fs.writeFileSync(
		path.join(bin, 'claude'),
		`#!/bin/sh\nprintf '%s\\0' "$@" > '${argsFile}'\n`,
		{mode: 0o755},
	);
	return {
		run(command: string) {
			const result = spawnSync('bash', ['-c', command], {
				env: {...process.env, PATH: `${bin}:${process.env['PATH']}`},
			});
			return result.status ?? undefined;
		},
		args: () => fs.readFileSync(argsFile, 'utf8').split('\0').slice(0, -1),
	};
}

test('the config fix hands claude the prompt and the home config dir, then removes the prompt', async () => {
	const paths = setup(
		{version: 1, claude: {model: 'opus'}},
		{version: 1, profiles: {plain: {display_name: 'Plain'}}},
	);
	const claude = stubClaude();
	let promptDir: string | undefined;
	const exitCode = await runConfigFix(
		'a reason',
		async command => {
			promptDir = path.dirname(/cat '([^']+)'/.exec(command)![1]!);
			return claude.run(command);
		},
		paths,
	);

	expect(exitCode).toBe(0);
	const [flag, addedDir, prompt] = claude.args();
	expect([flag, addedDir]).toStrictEqual(['--add-dir', paths.homeConfigDir]);
	expect(prompt!.includes('a reason')).toBe(true);
	expect(prompt!.includes('claude.model is deprecated')).toBe(true);
	expect(fs.existsSync(promptDir!)).toBe(false);
});

test('the config fix removes the prompt when running claude fails', async () => {
	const paths = setup(undefined, {version: 1, claude: {model: 'opus'}});
	let promptDir: string | undefined;
	await rejectionOf(
		runConfigFix(
			'a reason',
			async command => {
				promptDir = path.dirname(/cat '([^']+)'/.exec(command)![1]!);
				throw new Error('no popup');
			},
			paths,
		),
	).then(error => {
		expect(error.message).toBe('no popup');
	});
	expect(fs.existsSync(promptDir!)).toBe(false);
});
