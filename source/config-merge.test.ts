import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {PappardelleConfig} from './config.ts';
import {
	deepMerge,
	mergeConfigLayers,
	loadConfigFromPaths,
	validateConfig,
	getTeamPrefix,
	getProfileTeamPrefix,
	getInitializationCommand,
	getDangerouslySkipPermissions,
	getKeybindings,
	getIssueWatchlist,
	ConfigNotFoundError,
	ConfigValidationError,
} from './config.ts';

// ============================================================================
// Helper: temp directory with config files
// ============================================================================

function setupTempDir(files: Record<string, string>): {
	dir: string;
	cleanup: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-merge-'));
	for (const [name, content] of Object.entries(files)) {
		const filePath = path.join(dir, name);
		fs.mkdirSync(path.dirname(filePath), {recursive: true});
		fs.writeFileSync(filePath, content, 'utf-8');
	}

	return {
		dir,
		cleanup() {
			fs.rmSync(dir, {recursive: true, force: true});
		},
	};
}

// ============================================================================
// deepMerge — pure utility tests
// ============================================================================

test('deepMerge returns overlay when base is empty', t => {
	const result = deepMerge({}, {version: 1, team_prefix: 'ENG'});
	t.deepEqual(result, {version: 1, team_prefix: 'ENG'});
});

test('deepMerge returns base when overlay is empty', t => {
	const result = deepMerge({version: 1, team_prefix: 'ENG'}, {});
	t.deepEqual(result, {version: 1, team_prefix: 'ENG'});
});

test('deepMerge overrides scalar values', t => {
	const result = deepMerge(
		{version: 1, team_prefix: 'STA'},
		{team_prefix: 'ENG'},
	);
	t.is(result['team_prefix'], 'ENG');
	t.is(result['version'], 1);
});

test('deepMerge deeply merges nested objects', t => {
	const result = deepMerge(
		{
			claude: {
				initialization_command: '/idow',
				dangerously_skip_permissions: false,
			},
		},
		{claude: {dangerously_skip_permissions: true}},
	);
	const claude = result['claude'] as Record<string, unknown>;
	t.is(claude['initialization_command'], '/idow');
	t.is(claude['dangerously_skip_permissions'], true);
});

test('deepMerge replaces arrays entirely', t => {
	const result = deepMerge(
		{post_workspace_init: [{name: 'a', run: 'echo a'}]},
		{post_workspace_init: [{name: 'b', run: 'echo b'}]},
	);
	const cmds = result['post_workspace_init'] as Array<Record<string, unknown>>;
	t.is(cmds.length, 1);
	t.is(cmds[0]!['name'], 'b');
});

test('deepMerge merges profiles from both layers', t => {
	const result = deepMerge(
		{
			profiles: {
				music: {display_name: 'Music', keywords: ['music']},
			},
		},
		{
			profiles: {
				hive: {display_name: 'Hive', keywords: ['hive']},
			},
		},
	);
	const profiles = result['profiles'] as Record<string, unknown>;
	t.truthy(profiles['music']);
	t.truthy(profiles['hive']);
});

test('deepMerge overlay profile overrides base profile with same key', t => {
	const result = deepMerge(
		{
			profiles: {
				music: {
					display_name: 'Music OLD',
					keywords: ['music'],
					team_prefix: 'MUS',
				},
			},
		},
		{
			profiles: {
				music: {display_name: 'Music NEW'},
			},
		},
	);
	const profiles = result['profiles'] as Record<
		string,
		Record<string, unknown>
	>;
	t.is(profiles['music']!['display_name'], 'Music NEW');
	// Deep merge preserves fields from base profile not in overlay
	t.deepEqual(profiles['music']!['keywords'], ['music']);
	t.is(profiles['music']!['team_prefix'], 'MUS');
});

test('deepMerge handles null overlay value by replacing', t => {
	const result = deepMerge(
		{claude: {initialization_command: '/idow'}},
		{claude: null},
	);
	t.is(result['claude'], null);
});

// ============================================================================
// mergeConfigLayers — config-specific merge
// ============================================================================

test('mergeConfigLayers with home config only', t => {
	const home = {
		version: 1,
		team_prefix: 'HOME',
		profiles: {
			music: {display_name: 'Music', keywords: ['music']},
		},
	};
	const result = mergeConfigLayers(home, null, null);
	t.is(result['version'], 1);
	t.is(result['team_prefix'], 'HOME');
	const profiles = result['profiles'] as Record<string, unknown>;
	t.truthy(profiles['music']);
});

test('mergeConfigLayers with project config only', t => {
	const project = {
		version: 1,
		team_prefix: 'STA',
		profiles: {
			hive: {display_name: 'Hive', keywords: ['hive']},
		},
	};
	const result = mergeConfigLayers(null, project, null);
	t.is(result['team_prefix'], 'STA');
});

test('mergeConfigLayers with local config only', t => {
	const local = {
		version: 1,
		team_prefix: 'LOCAL',
		profiles: {
			test: {display_name: 'Test', keywords: ['test']},
		},
	};
	const result = mergeConfigLayers(null, null, local);
	t.is(result['team_prefix'], 'LOCAL');
});

test('mergeConfigLayers project overrides home', t => {
	const home = {
		version: 1,
		team_prefix: 'HOME',
		claude: {initialization_command: '/dow'},
		profiles: {
			music: {display_name: 'Music', keywords: ['music']},
		},
	};
	const project = {
		version: 1,
		team_prefix: 'STA',
		profiles: {
			hive: {display_name: 'Hive', keywords: ['hive']},
		},
	};
	const result = mergeConfigLayers(home, project, null);
	t.is(result['team_prefix'], 'STA');
	// Home's claude config is preserved since project didn't set it
	const claude = result['claude'] as Record<string, unknown>;
	t.is(claude['initialization_command'], '/dow');
	// Profiles from both layers
	const profiles = result['profiles'] as Record<string, unknown>;
	t.truthy(profiles['music']);
	t.truthy(profiles['hive']);
});

test('mergeConfigLayers local overrides project', t => {
	const project = {
		version: 1,
		team_prefix: 'STA',
		claude: {dangerously_skip_permissions: false},
		profiles: {
			hive: {display_name: 'Hive', keywords: ['hive']},
		},
	};
	const local = {
		team_prefix: 'LOCAL',
		claude: {dangerously_skip_permissions: true},
	};
	const result = mergeConfigLayers(null, project, local);
	t.is(result['team_prefix'], 'LOCAL');
	const claude = result['claude'] as Record<string, unknown>;
	t.is(claude['dangerously_skip_permissions'], true);
});

test('mergeConfigLayers three-layer merge: local > project > home', t => {
	const home = {
		version: 1,
		team_prefix: 'HOME',
		claude: {
			initialization_command: '/dow',
			dangerously_skip_permissions: false,
		},
		profiles: {
			music: {display_name: 'Music', keywords: ['music']},
		},
	};
	const project = {
		version: 1,
		team_prefix: 'STA',
		claude: {initialization_command: '/idow'},
		profiles: {
			hive: {display_name: 'Hive', keywords: ['hive']},
		},
	};
	const local = {
		claude: {dangerously_skip_permissions: true},
	};
	const result = mergeConfigLayers(home, project, local);

	// team_prefix: project overrides home, local doesn't set it
	t.is(result['team_prefix'], 'STA');
	// claude: init_cmd from project overrides home; skip_permissions from local overrides all
	const claude = result['claude'] as Record<string, unknown>;
	t.is(claude['initialization_command'], '/idow');
	t.is(claude['dangerously_skip_permissions'], true);
	// profiles: merged from both home and project
	const profiles = result['profiles'] as Record<string, unknown>;
	t.truthy(profiles['music']);
	t.truthy(profiles['hive']);
});

test('mergeConfigLayers smart-merges keybindings across layers', t => {
	const home = {
		version: 1,
		keybindings: [
			{key: 'b', name: 'Build', run: 'make build'},
			{key: 'r', name: 'Run', run: 'make run'},
		],
		profiles: {test: {display_name: 'Test'}},
	};
	const project = {
		keybindings: [
			{key: 'b', name: 'Build Proj', run: 'make build-proj'},
			{key: 't', name: 'Test', run: 'make test'},
		],
	};
	const local = {
		keybindings: [
			{key: 'r', disabled: true},
			{key: 'v', name: 'VS Code', run: 'code .'},
		],
	};
	const result = mergeConfigLayers(home, project, local);
	const bindings = result['keybindings'] as Array<Record<string, unknown>>;

	// 'b' overridden by project
	const bBinding = bindings.find(kb => kb['key'] === 'b');
	t.is(bBinding!['name'], 'Build Proj');
	// 'r' disabled by local
	const rBinding = bindings.find(kb => kb['key'] === 'r');
	t.is(rBinding, undefined);
	// 't' added by project
	const tBinding = bindings.find(kb => kb['key'] === 't');
	t.truthy(tBinding);
	// 'v' added by local
	const vBinding = bindings.find(kb => kb['key'] === 'v');
	t.truthy(vBinding);
});

// ============================================================================
// mergeConfigLayers — every config field from home/local works
// ============================================================================

test('team_prefix from home config works', t => {
	const result = mergeConfigLayers(
		{version: 1, team_prefix: 'HOME', profiles: {t: {display_name: 'T'}}},
		null,
		null,
	);
	validateConfig(result);
	t.is(getTeamPrefix(result as PappardelleConfig), 'HOME');
});

test('team_prefix from local config overrides project', t => {
	const result = mergeConfigLayers(
		null,
		{version: 1, team_prefix: 'STA', profiles: {t: {display_name: 'T'}}},
		{team_prefix: 'LOCAL'},
	);
	validateConfig(result);
	t.is(getTeamPrefix(result as PappardelleConfig), 'LOCAL');
});

test('issue_tracker from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			issue_tracker: {provider: 'jira', base_url: 'https://jira.example.com'},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(config.issue_tracker!.provider, 'jira');
	t.is(config.issue_tracker!.base_url, 'https://jira.example.com');
});

test('vcs_host from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			vcs_host: {provider: 'gitlab', host: 'https://gitlab.example.com'},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(config.vcs_host!.provider, 'gitlab');
});

test('claude config from home works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			claude: {
				initialization_command: '/dow',
				dangerously_skip_permissions: true,
			},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(getInitializationCommand(config), '/dow');
	t.is(getDangerouslySkipPermissions(config), true);
});

test('issue_watchlist from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			issue_watchlist: {assignee: 'me', statuses: ['To Do', 'In Progress']},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	const wl = getIssueWatchlist(config)!;
	t.is(wl.assignee, 'me');
	t.deepEqual(wl.statuses, ['To Do', 'In Progress']);
});

test('issue_watchlist from local overrides project', t => {
	const result = mergeConfigLayers(
		null,
		{
			version: 1,
			issue_watchlist: {assignee: 'me', statuses: ['To Do']},
			profiles: {t: {display_name: 'T'}},
		},
		{
			issue_watchlist: {
				assignee: 'charlie',
				statuses: ['In Progress', 'In Review'],
			},
		},
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	const wl = getIssueWatchlist(config)!;
	t.is(wl.assignee, 'charlie');
	t.deepEqual(wl.statuses, ['In Progress', 'In Review']);
});

test('post_workspace_init from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			post_workspace_init: [{name: 'setup', run: 'make setup'}],
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(config.post_workspace_init!.length, 1);
	t.is(config.post_workspace_init![0]!.run, 'make setup');
});

test('pre_workspace_deinit from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			pre_workspace_deinit: [{name: 'cleanup', run: 'make clean'}],
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(config.pre_workspace_deinit!.length, 1);
	t.is(config.pre_workspace_deinit![0]!.run, 'make clean');
});

test('terminal from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			terminal: {app: 'Warp'},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(config.terminal!.app, 'Warp');
});

test('hooks from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			hooks: {post_workspace_create: [{name: 'notify', run: 'echo created'}]},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(config.hooks!.post_workspace_create!.length, 1);
});

test('keybindings from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			keybindings: [{key: 'b', name: 'Build', run: 'make build'}],
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(getKeybindings(config).length, 1);
	t.is(getKeybindings(config)[0]!.key, 'b');
});

test('profiles from home config work with all profile features', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			profiles: {
				music: {
					display_name: 'Music',
					keywords: ['music', 'jams'],
					team_prefix: 'MUS',
					claude: {initialization_command: '/idow'},
					vars: {APP_DIR: '_ios/stardust-jams'},
					vcs: {label: 'stardust_jams'},
					links: [{url: 'https://example.com', title: 'Docs'}],
					apps: [{name: 'Xcode', command: 'open .'}],
					post_workspace_init: [{name: 'xcodegen', run: 'xcodegen generate'}],
					pre_workspace_deinit: [{name: 'cleanup', run: 'rm -rf build'}],
					commands: [{name: 'test', run: 'make test'}],
				},
			},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	const profile = config.profiles['music']!;
	t.is(profile.display_name, 'Music');
	t.deepEqual(profile.keywords, ['music', 'jams']);
	t.is(profile.team_prefix, 'MUS');
	t.is(profile.claude!.initialization_command, '/idow');
	t.is(profile.vars!['APP_DIR'], '_ios/stardust-jams');
	t.is(profile.vcs!.label, 'stardust_jams');
	t.is(profile.links!.length, 1);
	t.is(profile.apps!.length, 1);
	t.is(profile.post_workspace_init!.length, 1);
	t.is(profile.pre_workspace_deinit!.length, 1);
	t.is(profile.commands!.length, 1);
});

test('default_profile from home config works', t => {
	const result = mergeConfigLayers(
		{
			version: 1,
			default_profile: 'music',
			profiles: {
				music: {display_name: 'Music'},
				hive: {display_name: 'Hive'},
			},
		},
		null,
		null,
	);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(config.default_profile, 'music');
});

// ============================================================================
// mergeConfigLayers — project not needed when home or local provides all
// ============================================================================

test('config works without project config when home provides everything', t => {
	const home = {
		version: 1,
		team_prefix: 'HOME',
		claude: {initialization_command: '/dow'},
		issue_watchlist: {assignee: 'me', statuses: ['To Do']},
		keybindings: [{key: 'b', name: 'Build', run: 'make build'}],
		profiles: {
			music: {display_name: 'Music', keywords: ['music']},
		},
	};
	const result = mergeConfigLayers(home, null, null);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(getTeamPrefix(config), 'HOME');
	t.is(getInitializationCommand(config), '/dow');
	t.truthy(getIssueWatchlist(config));
	t.is(getKeybindings(config).length, 1);
	t.truthy(config.profiles['music']);
});

test('config works without project config when local provides everything', t => {
	const local = {
		version: 1,
		team_prefix: 'LOCAL',
		profiles: {
			test: {display_name: 'Test', keywords: ['test']},
		},
	};
	const result = mergeConfigLayers(null, null, local);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(getTeamPrefix(config), 'LOCAL');
});

test('home + local works without project config', t => {
	const home = {
		version: 1,
		team_prefix: 'HOME',
		claude: {initialization_command: '/dow'},
		profiles: {
			music: {display_name: 'Music', keywords: ['music']},
		},
	};
	const local = {
		team_prefix: 'LOCAL',
		claude: {dangerously_skip_permissions: true},
	};
	const result = mergeConfigLayers(home, null, local);
	validateConfig(result);
	const config = result as PappardelleConfig;
	t.is(getTeamPrefix(config), 'LOCAL');
	t.is(getInitializationCommand(config), '/dow');
	t.is(getDangerouslySkipPermissions(config), true);
});

// ============================================================================
// mergeConfigLayers — profile merging across layers
// ============================================================================

test('profiles from all three layers are merged', t => {
	const home = {
		version: 1,
		profiles: {
			music: {display_name: 'Music', keywords: ['music']},
		},
	};
	const project = {
		profiles: {
			hive: {display_name: 'Hive', keywords: ['hive']},
		},
	};
	const local = {
		profiles: {
			test: {display_name: 'Test', keywords: ['test']},
		},
	};
	const result = mergeConfigLayers(home, project, local);
	const profiles = result['profiles'] as Record<
		string,
		Record<string, unknown>
	>;
	t.truthy(profiles['music']);
	t.truthy(profiles['hive']);
	t.truthy(profiles['test']);
});

test('local profile overrides same-named project profile', t => {
	const project = {
		version: 1,
		profiles: {
			music: {
				display_name: 'Music V1',
				keywords: ['music'],
				team_prefix: 'MUS',
			},
		},
	};
	const local = {
		profiles: {
			music: {display_name: 'Music V2'},
		},
	};
	const result = mergeConfigLayers(null, project, local);
	const profiles = result['profiles'] as Record<
		string,
		Record<string, unknown>
	>;
	// display_name overridden by local
	t.is(profiles['music']!['display_name'], 'Music V2');
	// keywords preserved from project (deep merge)
	t.deepEqual(profiles['music']!['keywords'], ['music']);
	// team_prefix preserved from project (deep merge)
	t.is(profiles['music']!['team_prefix'], 'MUS');
});

// ============================================================================
// loadConfigFromPaths — file-based loading tests
// ============================================================================

test('loadConfigFromPaths loads from home config only', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
team_prefix: HOME
profiles:
  music:
    display_name: Music
    keywords:
      - music
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
		});
		t.is(getTeamPrefix(config), 'HOME');
		t.truthy(config.profiles['music']);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths loads from project config only', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
profiles:
  hive:
    display_name: Hive
    keywords:
      - hive
`,
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'STA');
		t.truthy(config.profiles['hive']);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths loads from local config only', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.local.yml': `version: 1
team_prefix: LOCAL
profiles:
  test:
    display_name: Test
`,
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'LOCAL');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths merges home + project', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
team_prefix: HOME
claude:
  initialization_command: /dow
profiles:
  music:
    display_name: Music
    keywords:
      - music
`,
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
profiles:
  hive:
    display_name: Hive
    keywords:
      - hive
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		// project overrides home's team_prefix
		t.is(getTeamPrefix(config), 'STA');
		// home's claude config preserved
		t.is(getInitializationCommand(config), '/dow');
		// profiles from both
		t.truthy(config.profiles['music']);
		t.truthy(config.profiles['hive']);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths merges all three layers', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
team_prefix: HOME
claude:
  initialization_command: /dow
  dangerously_skip_permissions: false
profiles:
  music:
    display_name: Music
    keywords:
      - music
`,
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
claude:
  initialization_command: /idow
profiles:
  hive:
    display_name: Hive
    keywords:
      - hive
`,
		'project/.pappardelle.local.yml': `claude:
  dangerously_skip_permissions: true
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'STA');
		t.is(getInitializationCommand(config), '/idow');
		t.is(getDangerouslySkipPermissions(config), true);
		t.truthy(config.profiles['music']);
		t.truthy(config.profiles['hive']);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths throws when no config found at any layer', t => {
	const {dir, cleanup} = setupTempDir({});
	try {
		t.throws(
			() =>
				loadConfigFromPaths({
					homeConfigDir: path.join(dir, 'home'),
					projectDir: path.join(dir, 'project'),
				}),
			{instanceOf: ConfigNotFoundError},
		);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths home provides profiles, project does not need them', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
profiles:
  music:
    display_name: Music
    keywords:
      - music
  hive:
    display_name: Hive
    keywords:
      - hive
`,
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
claude:
  initialization_command: /idow
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'STA');
		t.is(getInitializationCommand(config), '/idow');
		// Profiles come from home
		t.truthy(config.profiles['music']);
		t.truthy(config.profiles['hive']);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths keybindings smart-merged across layers from files', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
keybindings:
  - key: b
    name: Build
    run: make build
  - key: r
    name: Run
    run: make run
profiles:
  test:
    display_name: Test
`,
		'project/.pappardelle.yml': `version: 1
keybindings:
  - key: b
    name: Build Project
    run: make build-proj
  - key: t
    name: Test
    run: make test
profiles:
  test:
    display_name: Test
`,
		'project/.pappardelle.local.yml': `keybindings:
  - key: r
    disabled: true
  - key: v
    name: VS Code
    run: code .
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		const bindings = getKeybindings(config);
		// 'b' overridden by project
		const b = bindings.find(kb => kb.key === 'b');
		t.is(b!.name, 'Build Project');
		// 'r' disabled by local
		const r = bindings.find(kb => kb.key === 'r');
		t.is(r, undefined);
		// 't' from project
		const tKey = bindings.find(kb => kb.key === 't');
		t.truthy(tKey);
		// 'v' from local
		const v = bindings.find(kb => kb.key === 'v');
		t.truthy(v);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths local can override every field from files', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
terminal:
  app: iTerm
issue_tracker:
  provider: linear
vcs_host:
  provider: github
profiles:
  hive:
    display_name: Hive
    keywords:
      - hive
`,
		'project/.pappardelle.local.yml': `team_prefix: LOCAL
terminal:
  app: Warp
issue_tracker:
  provider: jira
  base_url: https://jira.example.com
vcs_host:
  provider: gitlab
  host: https://gitlab.example.com
`,
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'LOCAL');
		t.is(config.terminal!.app, 'Warp');
		t.is(config.issue_tracker!.provider, 'jira');
		t.is(config.vcs_host!.provider, 'gitlab');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths gracefully ignores missing home config dir', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
profiles:
  test:
    display_name: Test
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'nonexistent'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'STA');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths home config dir uses .pappardelle.yml filename', t => {
	// The home config file should be at ~/.pappardelle/.pappardelle.yml
	const {dir, cleanup} = setupTempDir({
		'.pappardelle.yml': `version: 1
team_prefix: HOME
profiles:
  test:
    display_name: Test
`,
	});
	try {
		// dir itself is the "home config dir" (like ~/.pappardelle/)
		const config = loadConfigFromPaths({
			homeConfigDir: dir,
		});
		t.is(getTeamPrefix(config), 'HOME');
	} finally {
		cleanup();
	}
});

// ============================================================================
// loadConfigFromPaths — empty YAML files
// ============================================================================

test('loadConfigFromPaths ignores empty home YAML file', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': '',
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
profiles:
  t:
    display_name: T
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'STA');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths ignores empty project YAML file', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
team_prefix: HOME
profiles:
  t:
    display_name: T
`,
		'project/.pappardelle.yml': '',
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'HOME');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths ignores empty local YAML file', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
profiles:
  t:
    display_name: T
`,
		'project/.pappardelle.local.yml': '',
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'project'),
		});
		t.is(getTeamPrefix(config), 'STA');
	} finally {
		cleanup();
	}
});

// ============================================================================
// loadConfigFromPaths — YAML parse error handling
// ============================================================================

test('loadConfigFromPaths wraps invalid home YAML in ConfigValidationError', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
  bad indentation: [`,
	});
	try {
		const error = t.throws(
			() =>
				loadConfigFromPaths({
					homeConfigDir: path.join(dir, 'home'),
				}),
			{instanceOf: ConfigValidationError},
		);
		t.truthy(error?.message.includes('.pappardelle.yml'));
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths wraps invalid project YAML in ConfigValidationError', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
  bad indentation: [`,
	});
	try {
		const error = t.throws(
			() =>
				loadConfigFromPaths({
					projectDir: path.join(dir, 'project'),
				}),
			{instanceOf: ConfigValidationError},
		);
		t.truthy(error?.message.includes('.pappardelle.yml'));
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths wraps invalid local YAML in ConfigValidationError', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
profiles:
  t:
    display_name: T
`,
		'project/.pappardelle.local.yml': `bad: [`,
	});
	try {
		const error = t.throws(
			() =>
				loadConfigFromPaths({
					projectDir: path.join(dir, 'project'),
				}),
			{instanceOf: ConfigValidationError},
		);
		t.truthy(error?.message.includes('.pappardelle.local.yml'));
	} finally {
		cleanup();
	}
});
