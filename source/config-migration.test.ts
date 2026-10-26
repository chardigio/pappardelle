import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import YAML from 'js-yaml';
import {
	findDeprecatedClaudeFields,
	getAgentProfile,
	getInitializationCommand,
	loadConfigFromPaths,
	renderAgentLaunchFlags,
	type ConfigPaths,
	type PappardelleConfig,
} from './config.ts';
import {
	applyConfigMigrations,
	confirmConfigMigrations,
	dismissResolvedDeprecationWarnings,
	planConfigMigrations,
	type ConfigMigration,
} from './config-migration.ts';
import {getRecentErrors} from './logger.ts';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'config-migration-'));

function writeConfig(dir: string, file: string, config: unknown) {
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(
		path.join(dir, file),
		typeof config === 'string' ? config : YAML.dump(config),
	);
}

function setup(
	home: unknown,
	project?: unknown,
	local?: unknown,
	homeConfigDir = path.join(root(), 'home'),
): Required<Pick<ConfigPaths, 'homeConfigDir' | 'projectDir'>> {
	const projectDir = path.join(root(), 'project');
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

test('every profile launches the same way after the rewrite', t => {
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

	t.is(migrations.length, 2);
	const after = loadConfigFromPaths(paths);
	t.deepEqual(launches(after), launches(before));
	t.is(getInitializationCommand(after), '/idow');
	t.is(after.profiles['project']!.initialization_command, '/plan');
	t.true(after.claude?.dangerously_skip_permissions);
	for (const {path: file} of migrations) {
		const layer = YAML.load(fs.readFileSync(file, 'utf8')) as Record<
			string,
			unknown
		>;
		t.deepEqual(findDeprecatedClaudeFields(layer), []);
	}

	t.deepEqual(planConfigMigrations(paths), {kind: 'none'});
});

test('the shared home config never takes on one repo’s settings', t => {
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
	const repoQ = setup(
		undefined,
		{version: 1, profiles: {}},
		undefined,
		repoP.homeConfigDir,
	);
	const beforeP = launches(loadConfigFromPaths(repoP));
	const beforeQ = launches(loadConfigFromPaths(repoQ));

	migrate(repoP);

	t.deepEqual(launches(loadConfigFromPaths(repoP)), beforeP);
	t.deepEqual(launches(loadConfigFromPaths(repoQ)), beforeQ);
});

test('extra args survive a higher file that sets the agent profile’s args', t => {
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

	t.deepEqual(launches(loadConfigFromPaths(paths)), before);
});

test('a block-scalar args value still loads once extra args join it', t => {
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

	t.deepEqual(launches(loadConfigFromPaths(paths)), before);
});

test('an agent profile named like the generated one is left alone', t => {
	const paths = setup({
		version: 1,
		agent_profiles: {'work-claude': {command: 'codex'}},
		profiles: {work: {display_name: 'Work', claude: {model: 'opus'}}},
	});
	const before = launches(loadConfigFromPaths(paths));

	migrate(paths);

	const after = loadConfigFromPaths(paths);
	t.deepEqual(after.agent_profiles?.['work-claude'], {command: 'codex'});
	t.is(after.profiles['work']!.agent_profile, 'work-claude-2');
	t.deepEqual(launches(after), before);
});

test('no rewrite is offered when a higher file would undo it', t => {
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

	t.like(planConfigMigrations(paths), {kind: 'unsupported'});
});

test('comments and untouched keys keep their formatting', t => {
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

	t.is(
		fs.readFileSync(path.join(paths.homeConfigDir, '.pappardelle.yml'), 'utf8'),
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

test('comments on moved keys follow them, and a header above claude: stays', t => {
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

	t.is(
		fs.readFileSync(path.join(paths.homeConfigDir, '.pappardelle.yml'), 'utf8'),
		[
			'# home config',
			'version: 1',
			'profiles: {}',
			'# kick off',
			'initialization_command: "/idow"',
			'agent_profiles:',
			'  claude:',
			'    command: claude',
			'    # why opus',
			'    model: opus',
			'',
		].join('\n'),
	);
});

test('a config on the current format needs no rewrite', t => {
	const paths = setup({
		version: 1,
		initialization_command: '/idow',
		agent_profiles: {claude: {command: 'claude', model: 'opus'}},
		profiles: {plain: {display_name: 'Plain'}},
	});

	t.deepEqual(planConfigMigrations(paths), {kind: 'none'});
});

test('the rewrite clears the deprecation warnings from the error pane', t => {
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
	t.true(isWarning());

	migrate(paths);

	t.false(isWarning());
});

test('no file is rewritten when any of them cannot be written', t => {
	const paths = setup(
		{version: 1, claude: {model: 'opus'}, profiles: {}},
		{version: 1, claude: {effort: 'low'}, profiles: {}},
	);
	const migrations = readyMigrations(paths);
	const homeFile = path.join(paths.homeConfigDir, '.pappardelle.yml');
	const original = fs.readFileSync(homeFile, 'utf8');
	fs.chmodSync(paths.projectDir, 0o555);
	try {
		t.throws(() => {
			applyConfigMigrations(migrations);
		});
	} finally {
		fs.chmodSync(paths.projectDir, 0o755);
	}

	t.is(fs.readFileSync(homeFile, 'utf8'), original);
	t.deepEqual(fs.readdirSync(paths.homeConfigDir), ['.pappardelle.yml']);
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
	test(`a higher file's empty ${name} still clears the one beneath it`, t => {
		const paths = setup(
			{version: 1, profiles: {}, ...home},
			{version: 1, profiles: {}, ...project},
		);
		const before = launches(loadConfigFromPaths(paths));

		migrate(paths);

		t.deepEqual(launches(loadConfigFromPaths(paths)), before);
	});
}

test('YAML aliases make the rewrite unsupported rather than throw', t => {
	const paths = setup(
		[
			'version: 1',
			'claude: &base {model: opus}',
			'profiles:',
			'  p: {display_name: P, claude: *base}',
			'',
		].join('\n'),
	);

	t.like(planConfigMigrations(paths), {kind: 'unsupported'});
});

test('a symlinked config is rewritten at its target with its permissions', t => {
	const paths = setup(undefined, {version: 1, profiles: {}});
	const dotfiles = path.join(root(), 'pappardelle.yml');
	fs.writeFileSync(dotfiles, YAML.dump({version: 1, claude: {model: 'opus'}}));
	fs.chmodSync(dotfiles, 0o664);
	fs.mkdirSync(paths.homeConfigDir, {recursive: true});
	const link = path.join(paths.homeConfigDir, '.pappardelle.yml');
	fs.symlinkSync(dotfiles, link);

	migrate(paths);

	t.true(fs.lstatSync(link).isSymbolicLink());
	t.deepEqual(
		findDeprecatedClaudeFields(
			YAML.load(fs.readFileSync(dotfiles, 'utf8')) as Record<string, unknown>,
		),
		[],
	);
	t.is((fs.statSync(dotfiles).mode % 0o1000).toString(8), '664');
});

test('a read-only config is not rewritten', t => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const file = path.join(paths.homeConfigDir, '.pappardelle.yml');
	const original = fs.readFileSync(file, 'utf8');
	fs.chmodSync(file, 0o444);

	t.throws(() => {
		applyConfigMigrations(readyMigrations(paths));
	});
	t.is(fs.readFileSync(file, 'utf8'), original);
});

test('warnings clear once the old keys are gone, even by hand', t => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const isWarning = () =>
		getRecentErrors().some(entry =>
			entry.message.includes('claude.model is deprecated'),
		);
	loadConfigFromPaths(paths);
	dismissResolvedDeprecationWarnings(paths);
	t.true(isWarning());

	writeConfig(paths.homeConfigDir, '.pappardelle.yml', {
		version: 1,
		profiles: {},
	});
	dismissResolvedDeprecationWarnings(paths);

	t.false(isWarning());
});

test('confirming rewrites the files the user was shown', t => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const approved = readyMigrations(paths);

	t.deepEqual(confirmConfigMigrations(approved, paths), {kind: 'rewritten'});
	t.deepEqual(planConfigMigrations(paths), {kind: 'none'});
});

test('confirming keeps edits made while the dialog was open', t => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const approved = readyMigrations(paths);
	writeConfig(paths.homeConfigDir, '.pappardelle.yml', {
		version: 1,
		claude: {model: 'opus'},
		profiles: {added: {display_name: 'Added'}},
	});

	t.deepEqual(confirmConfigMigrations(approved, paths), {kind: 'rewritten'});
	t.truthy(loadConfigFromPaths(paths).profiles['added']);
});

test('confirming writes nothing once the rewrite covers files the user was not shown', t => {
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

	t.deepEqual(confirmConfigMigrations(approved, paths), {kind: 'changed'});
	t.is(fs.readFileSync(homeFile, 'utf8'), edited);
});

test('confirming reports a failed write so it can be handed to Claude', t => {
	const paths = setup({version: 1, claude: {model: 'opus'}, profiles: {}});
	const approved = readyMigrations(paths);
	fs.chmodSync(path.join(paths.homeConfigDir, '.pappardelle.yml'), 0o444);

	t.like(confirmConfigMigrations(approved, paths), {kind: 'failed'});
});

test('a multi-line extra arg is named as the reason it cannot be rewritten', t => {
	const paths = setup({
		version: 1,
		claude: {extra_args: ['--append-system-prompt', 'line one\nline two']},
		profiles: {},
	});

	t.deepEqual(planConfigMigrations(paths), {
		kind: 'unsupported',
		reason:
			"~/.pappardelle/.pappardelle.yml: claude.extra_args has a multi-line value, and an agent profile's args must fit on one line",
	});
});

test('a partial fix clears the warnings for the keys that are gone', t => {
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

	t.false(dismissResolvedDeprecationWarnings(paths));

	t.true(isWarning('model'));
	t.false(isWarning('effort'));
});
