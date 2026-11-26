import {test, expect} from 'bun:test';
import {thrownBy} from '../test/helpers/thrown.ts';
import path from 'node:path';
import type {PappardelleConfig} from './config.ts';
import {setupTempDir, writeFiles} from '../test/helpers/config-fixtures.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	deepMerge,
	mergeConfigLayers,
	loadConfigFromPaths,
	readHomeSqliteState,
	getTeamPrefix,
	getInitializationCommand,
	getAgentProfile,
	getDangerouslySkipPermissions,
	getKeybindings,
	getIssueWatchlist,
	getStateColors,
} from './config.ts';
import {validateConfig} from './config-validation.ts';
import {ConfigNotFoundError, ConfigValidationError} from './config-errors.ts';
import {getRecentErrors} from './logger.ts';

// ============================================================================
// deepMerge — pure utility tests
// ============================================================================

test('deepMerge returns overlay when base is empty', () => {
	const result = deepMerge({}, {version: 1, team_prefix: 'ENG'});
	expect(result).toStrictEqual({version: 1, team_prefix: 'ENG'});
});

test('deepMerge returns base when overlay is empty', () => {
	const result = deepMerge({version: 1, team_prefix: 'ENG'}, {});
	expect(result).toStrictEqual({version: 1, team_prefix: 'ENG'});
});

test('deepMerge overrides scalar values', () => {
	const result = deepMerge(
		{version: 1, team_prefix: 'STA'},
		{team_prefix: 'ENG'},
	);
	expect(result['team_prefix']).toBe('ENG');
	expect(result['version']).toBe(1);
});

test('deepMerge deeply merges nested objects', () => {
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
	expect(claude['initialization_command']).toBe('/idow');
	expect(claude['dangerously_skip_permissions']).toBe(true);
});

test('deepMerge replaces arrays entirely', () => {
	const result = deepMerge(
		{post_workspace_init: [{name: 'a', run: 'echo a'}]},
		{post_workspace_init: [{name: 'b', run: 'echo b'}]},
	);
	const cmds = result['post_workspace_init'] as Array<Record<string, unknown>>;
	expect(cmds.length).toBe(1);
	expect(cmds[0]!['name']).toBe('b');
});

test('deepMerge merges profiles from both layers', () => {
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
	expect(profiles['music']).toBeTruthy();
	expect(profiles['hive']).toBeTruthy();
});

test('deepMerge overlay profile overrides base profile with same key', () => {
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
	expect(profiles['music']!['display_name']).toBe('Music NEW');
	// Deep merge preserves fields from base profile not in overlay
	expect(profiles['music']!['keywords']).toStrictEqual(['music']);
	expect(profiles['music']!['team_prefix']).toBe('MUS');
});

test('deepMerge handles null overlay value by replacing', () => {
	const result = deepMerge(
		{claude: {initialization_command: '/idow'}},
		{claude: null},
	);
	expect(result['claude']).toBe(null);
});

// ============================================================================
// mergeConfigLayers — config-specific merge
// ============================================================================

test('mergeConfigLayers with home config only', () => {
	const home = {
		version: 1,
		team_prefix: 'HOME',
		profiles: {
			music: {display_name: 'Music', keywords: ['music']},
		},
	};
	const result = mergeConfigLayers([home, null, null]);
	expect(result['version']).toBe(1);
	expect(result['team_prefix']).toBe('HOME');
	const profiles = result['profiles'] as Record<string, unknown>;
	expect(profiles['music']).toBeTruthy();
});

test('mergeConfigLayers with project config only', () => {
	const project = {
		version: 1,
		team_prefix: 'STA',
		profiles: {
			hive: {display_name: 'Hive', keywords: ['hive']},
		},
	};
	const result = mergeConfigLayers([null, project, null]);
	expect(result['team_prefix']).toBe('STA');
});

test('mergeConfigLayers with local config only', () => {
	const local = {
		version: 1,
		team_prefix: 'LOCAL',
		profiles: {
			test: {display_name: 'Test', keywords: ['test']},
		},
	};
	const result = mergeConfigLayers([null, null, local]);
	expect(result['team_prefix']).toBe('LOCAL');
});

test('mergeConfigLayers project overrides home', () => {
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
	const result = mergeConfigLayers([home, project, null]);
	expect(result['team_prefix']).toBe('STA');
	// Home's claude config is preserved since project didn't set it
	const claude = result['claude'] as Record<string, unknown>;
	expect(claude['initialization_command']).toBe('/dow');
	// Profiles from both layers
	const profiles = result['profiles'] as Record<string, unknown>;
	expect(profiles['music']).toBeTruthy();
	expect(profiles['hive']).toBeTruthy();
});

test('mergeConfigLayers local overrides project', () => {
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
	const result = mergeConfigLayers([null, project, local]);
	expect(result['team_prefix']).toBe('LOCAL');
	const claude = result['claude'] as Record<string, unknown>;
	expect(claude['dangerously_skip_permissions']).toBe(true);
});

test('mergeConfigLayers three-layer merge: local > project > home', () => {
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
	const result = mergeConfigLayers([home, project, local]);

	// team_prefix: project overrides home, local doesn't set it
	expect(result['team_prefix']).toBe('STA');
	// claude: init_cmd from project overrides home; skip_permissions from local overrides all
	const claude = result['claude'] as Record<string, unknown>;
	expect(claude['initialization_command']).toBe('/idow');
	expect(claude['dangerously_skip_permissions']).toBe(true);
	// profiles: merged from both home and project
	const profiles = result['profiles'] as Record<string, unknown>;
	expect(profiles['music']).toBeTruthy();
	expect(profiles['hive']).toBeTruthy();
});

test('mergeConfigLayers smart-merges keybindings across layers', () => {
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
	const result = mergeConfigLayers([home, project, local]);
	const bindings = result['keybindings'] as Array<Record<string, unknown>>;

	// 'b' overridden by project
	const bBinding = bindings.find(kb => kb['key'] === 'b');
	expect(bBinding!['name']).toBe('Build Proj');
	// 'r' disabled by local
	const rBinding = bindings.find(kb => kb['key'] === 'r');
	expect(rBinding).toBe(undefined);
	// 't' added by project
	const tBinding = bindings.find(kb => kb['key'] === 't');
	expect(tBinding).toBeTruthy();
	// 'v' added by local
	const vBinding = bindings.find(kb => kb['key'] === 'v');
	expect(vBinding).toBeTruthy();
});

// ============================================================================
// mergeConfigLayers — every config field from home/local works
// ============================================================================

test('team_prefix from home config works', () => {
	const result = mergeConfigLayers([
		{version: 1, team_prefix: 'HOME', profiles: {t: {display_name: 'T'}}},
		null,
		null,
	]);
	validateConfig(result);
	expect(getTeamPrefix(result as PappardelleConfig)).toBe('HOME');
});

test('team_prefix from local config overrides project', () => {
	const result = mergeConfigLayers([
		null,
		{version: 1, team_prefix: 'STA', profiles: {t: {display_name: 'T'}}},
		{team_prefix: 'LOCAL'},
	]);
	validateConfig(result);
	expect(getTeamPrefix(result as PappardelleConfig)).toBe('LOCAL');
});

test('issue_tracker from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			issue_tracker: {provider: 'jira', base_url: 'https://jira.example.com'},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.issue_tracker!.provider).toBe('jira');
	expect(config.issue_tracker!.base_url).toBe('https://jira.example.com');
});

test('vcs_host from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			vcs_host: {provider: 'gitlab', host: 'https://gitlab.example.com'},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.vcs_host!.provider).toBe('gitlab');
});

test('claude config from home works', () => {
	const result = mergeConfigLayers([
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
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(getInitializationCommand(config)).toBe('/dow');
	expect(getDangerouslySkipPermissions(config)).toBe(true);
});

test('issue_watchlist from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			issue_watchlist: {assignee: 'me', statuses: ['To Do', 'In Progress']},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	const wl = getIssueWatchlist(config)!;
	expect(wl.assignee).toBe('me');
	expect(wl.statuses).toStrictEqual(['To Do', 'In Progress']);
});

test('issue_watchlist from local overrides project', () => {
	const result = mergeConfigLayers([
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
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	const wl = getIssueWatchlist(config)!;
	expect(wl.assignee).toBe('charlie');
	expect(wl.statuses).toStrictEqual(['In Progress', 'In Review']);
});

test('post_workspace_init from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			post_workspace_init: [{name: 'setup', run: 'make setup'}],
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.post_workspace_init!.length).toBe(1);
	expect(config.post_workspace_init![0]!.run).toBe('make setup');
});

test('pre_workspace_deinit from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			pre_workspace_deinit: [{name: 'cleanup', run: 'make clean'}],
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.pre_workspace_deinit!.length).toBe(1);
	expect(config.pre_workspace_deinit![0]!.run).toBe('make clean');
});

test('terminal from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			terminal: {app: 'Warp'},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.terminal!.app).toBe('Warp');
});

test('hooks from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			hooks: {post_workspace_create: [{name: 'notify', run: 'echo created'}]},
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.hooks!.post_workspace_create!.length).toBe(1);
});

test('keybindings from home config works', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			keybindings: [{key: 'b', name: 'Build', run: 'make build'}],
			profiles: {t: {display_name: 'T'}},
		},
		null,
		null,
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(getKeybindings(config).length).toBe(1);
	expect(getKeybindings(config)[0]!.key).toBe('b');
});

test('profiles from home config work with all profile features', () => {
	const result = mergeConfigLayers([
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
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	const profile = config.profiles['music']!;
	expect(profile.display_name).toBe('Music');
	expect(profile.keywords).toStrictEqual(['music', 'jams']);
	expect(profile.team_prefix).toBe('MUS');
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- pins the deprecated spelling still merging correctly
	expect(profile.claude!.initialization_command).toBe('/idow');
	expect(profile.vars!['APP_DIR']).toBe('_ios/stardust-jams');
	expect(profile.vcs!.label).toBe('stardust_jams');
	expect(profile.links!.length).toBe(1);
	expect(profile.apps!.length).toBe(1);
	expect(profile.post_workspace_init!.length).toBe(1);
	expect(profile.pre_workspace_deinit!.length).toBe(1);
	expect(profile.commands!.length).toBe(1);
});

test('default_profile from home config works', () => {
	const result = mergeConfigLayers([
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
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.default_profile).toBe('music');
});

test('default_profile from local config overrides project', () => {
	const result = mergeConfigLayers([
		null,
		{
			version: 1,
			default_profile: 'hive',
			profiles: {
				music: {display_name: 'Music'},
				hive: {display_name: 'Hive'},
			},
		},
		{default_profile: 'music'},
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.default_profile).toBe('music');
});

test('default_profile from local config overrides home', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			default_profile: 'music',
			profiles: {
				music: {display_name: 'Music'},
				hive: {display_name: 'Hive'},
			},
		},
		null,
		{default_profile: 'hive'},
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(config.default_profile).toBe('hive');
});

test('default_profile from local overrides all three layers', () => {
	const result = mergeConfigLayers([
		{
			version: 1,
			default_profile: 'music',
			profiles: {
				music: {display_name: 'Music'},
			},
		},
		{
			default_profile: 'hive',
			profiles: {
				hive: {display_name: 'Hive'},
			},
		},
		{default_profile: 'music'},
	]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	// local wins: picks 'music' even though project set 'hive'
	expect(config.default_profile).toBe('music');
	// Both profiles are still present from home + project merge
	expect(config.profiles['music']).toBeTruthy();
	expect(config.profiles['hive']).toBeTruthy();
});

// ============================================================================
// mergeConfigLayers — project not needed when home or local provides all
// ============================================================================

test('config works without project config when home provides everything', () => {
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
	const result = mergeConfigLayers([home, null, null]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(getTeamPrefix(config)).toBe('HOME');
	expect(getInitializationCommand(config)).toBe('/dow');
	expect(getIssueWatchlist(config)).toBeTruthy();
	expect(getKeybindings(config).length).toBe(1);
	expect(config.profiles['music']).toBeTruthy();
});

test('config works without project config when local provides everything', () => {
	const local = {
		version: 1,
		team_prefix: 'LOCAL',
		profiles: {
			test: {display_name: 'Test', keywords: ['test']},
		},
	};
	const result = mergeConfigLayers([null, null, local]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(getTeamPrefix(config)).toBe('LOCAL');
});

test('home + local works without project config', () => {
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
	const result = mergeConfigLayers([home, null, local]);
	validateConfig(result);
	const config = result as PappardelleConfig;
	expect(getTeamPrefix(config)).toBe('LOCAL');
	expect(getInitializationCommand(config)).toBe('/dow');
	expect(getDangerouslySkipPermissions(config)).toBe(true);
});

// ============================================================================
// mergeConfigLayers — profile merging across layers
// ============================================================================

test('profiles from all three layers are merged', () => {
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
	const result = mergeConfigLayers([home, project, local]);
	const profiles = result['profiles'] as Record<
		string,
		Record<string, unknown>
	>;
	expect(profiles['music']).toBeTruthy();
	expect(profiles['hive']).toBeTruthy();
	expect(profiles['test']).toBeTruthy();
});

test('local profile overrides same-named project profile', () => {
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
	const result = mergeConfigLayers([null, project, local]);
	const profiles = result['profiles'] as Record<
		string,
		Record<string, unknown>
	>;
	// display_name overridden by local
	expect(profiles['music']!['display_name']).toBe('Music V2');
	// keywords preserved from project (deep merge)
	expect(profiles['music']!['keywords']).toStrictEqual(['music']);
	// team_prefix preserved from project (deep merge)
	expect(profiles['music']!['team_prefix']).toBe('MUS');
});

// ============================================================================
// loadConfigFromPaths — file-based loading tests
// ============================================================================

test('loadConfigFromPaths loads from home config only', () => {
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
		expect(getTeamPrefix(config)).toBe('HOME');
		expect(config.profiles['music']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths loads from project config only', () => {
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
		expect(getTeamPrefix(config)).toBe('STA');
		expect(config.profiles['hive']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths loads from local config only', () => {
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
		expect(getTeamPrefix(config)).toBe('LOCAL');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths merges home + project', () => {
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
		expect(getTeamPrefix(config)).toBe('STA');
		// home's claude config preserved
		expect(getInitializationCommand(config)).toBe('/dow');
		// profiles from both
		expect(config.profiles['music']).toBeTruthy();
		expect(config.profiles['hive']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths merges all three layers', () => {
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
		expect(getTeamPrefix(config)).toBe('STA');
		expect(getInitializationCommand(config)).toBe('/idow');
		expect(getDangerouslySkipPermissions(config)).toBe(true);
		expect(config.profiles['music']).toBeTruthy();
		expect(config.profiles['hive']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths throws when no config found at any layer', () => {
	const {dir, cleanup} = setupTempDir({});
	try {
		expect(() =>
			loadConfigFromPaths({
				homeConfigDir: path.join(dir, 'home'),
				projectDir: path.join(dir, 'project'),
			}),
		).toThrow(ConfigNotFoundError);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths home provides profiles, project does not need them', () => {
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
		expect(getTeamPrefix(config)).toBe('STA');
		expect(getInitializationCommand(config)).toBe('/idow');
		// Profiles come from home
		expect(config.profiles['music']).toBeTruthy();
		expect(config.profiles['hive']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths keybindings smart-merged across layers from files', () => {
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
		expect(b!.name).toBe('Build Project');
		// 'r' disabled by local
		const r = bindings.find(kb => kb.key === 'r');
		expect(r).toBe(undefined);
		// 't' from project
		const tKey = bindings.find(kb => kb.key === 't');
		expect(tKey).toBeTruthy();
		// 'v' from local
		const v = bindings.find(kb => kb.key === 'v');
		expect(v).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths local can override every field from files', () => {
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
		expect(getTeamPrefix(config)).toBe('LOCAL');
		expect(config.terminal!.app).toBe('Warp');
		expect(config.issue_tracker!.provider).toBe('jira');
		expect(config.vcs_host!.provider).toBe('gitlab');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths local overrides default_profile from project', () => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
team_prefix: STA
default_profile: hive
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
		'project/.pappardelle.local.yml': `default_profile: music
`,
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'project'),
		});
		expect(config.default_profile).toBe('music');
		// Both profiles still present
		expect(config.profiles['music']).toBeTruthy();
		expect(config.profiles['hive']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths gracefully ignores missing home config dir', () => {
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
		expect(getTeamPrefix(config)).toBe('STA');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths home config dir uses .pappardelle.yml filename', () => {
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
		expect(getTeamPrefix(config)).toBe('HOME');
	} finally {
		cleanup();
	}
});

// ============================================================================
// loadConfigFromPaths — empty YAML files
// ============================================================================

test('loadConfigFromPaths accepts old init spelling in one layer and new in another', () => {
	// Regression: the both-spellings check used to run on the MERGED config, so
	// a home config still on the deprecated spelling bricked a project that
	// had already migrated — despite each file being individually valid.
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
claude:
  initialization_command: /old
profiles:
  t:
    display_name: T
`,
		'project/.pappardelle.yml': `version: 1
initialization_command: /new
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
		expect(getInitializationCommand(config)).toBe('/new');
		// Each layer's deprecated key is renamed before the merge.
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- pins the rename of the deprecated spelling
		expect(config.claude?.initialization_command).toBe(undefined);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths accepts cross-layer init spellings per profile', () => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
profiles:
  t:
    display_name: T
    claude:
      initialization_command: /old
`,
		'project/.pappardelle.yml': `version: 1
profiles:
  t:
    display_name: T
    initialization_command: /new
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		expect(config.profiles['t']!.initialization_command).toBe('/new');
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- pins the rename of the deprecated spelling
		expect(config.profiles['t']!.claude?.initialization_command).toBe(
			undefined,
		);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths lets a more specific layer on the old init spelling win', () => {
	// Layer precedence decides, not which spelling a layer uses: a project
	// that hasn't migrated yet still overrides a home config that has.
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
initialization_command: /home
profiles:
  t:
    display_name: T
    initialization_command: /home-profile
`,
		'project/.pappardelle.yml': `version: 1
claude:
  initialization_command: /project
profiles:
  t:
    display_name: T
    claude:
      initialization_command: /project-profile
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		expect(getInitializationCommand(config)).toBe('/project');
		expect(config.profiles['t']!.initialization_command).toBe(
			'/project-profile',
		);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths rejects both init spellings on one profile in the same file', () => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
profiles:
  t:
    display_name: T
    initialization_command: /a
    claude:
      initialization_command: /b
`,
	});
	try {
		const error = thrownBy(
			() => loadConfigFromPaths({projectDir: path.join(dir, 'project')}),
			ConfigValidationError,
		);
		expect(
			error?.message.includes('profiles.t.initialization_command'),
		).toBeTruthy();
		expect(error?.message.includes('cannot both be specified')).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths rejects both init spellings in the same file, naming it', () => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
initialization_command: /new
claude:
  initialization_command: /old
profiles:
  t:
    display_name: T
`,
	});
	try {
		const error = thrownBy(
			() => loadConfigFromPaths({projectDir: path.join(dir, 'project')}),
			ConfigValidationError,
		);
		expect(error?.message.includes('.pappardelle.yml')).toBeTruthy();
		expect(error?.message.includes('cannot both be specified')).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths ignores empty home YAML file', () => {
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
		expect(getTeamPrefix(config)).toBe('STA');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths ignores empty project YAML file', () => {
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
		expect(getTeamPrefix(config)).toBe('HOME');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths ignores empty local YAML file', () => {
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
		expect(getTeamPrefix(config)).toBe('STA');
	} finally {
		cleanup();
	}
});

// ============================================================================
// loadConfigFromPaths — YAML parse error handling
// ============================================================================

test('loadConfigFromPaths wraps invalid home YAML in ConfigValidationError', () => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
  bad indentation: [`,
	});
	try {
		const error = thrownBy(
			() =>
				loadConfigFromPaths({
					homeConfigDir: path.join(dir, 'home'),
				}),
			ConfigValidationError,
		);
		expect(error?.message.includes('.pappardelle.yml')).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths wraps invalid project YAML in ConfigValidationError', () => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
  bad indentation: [`,
	});
	try {
		const error = thrownBy(
			() =>
				loadConfigFromPaths({
					projectDir: path.join(dir, 'project'),
				}),
			ConfigValidationError,
		);
		expect(error?.message.includes('.pappardelle.yml')).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths wraps invalid local YAML in ConfigValidationError', () => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
profiles:
  t:
    display_name: T
`,
		'project/.pappardelle.local.yml': `bad: [`,
	});
	try {
		const error = thrownBy(
			() =>
				loadConfigFromPaths({
					projectDir: path.join(dir, 'project'),
				}),
			ConfigValidationError,
		);
		expect(error?.message.includes('.pappardelle.local.yml')).toBeTruthy();
	} finally {
		cleanup();
	}
});

// ============================================================================
// state_colors layer merge
// ============================================================================

test('state_colors merges key by key across project and local layers', () => {
	const {dir, cleanup} = setupTempDir({
		'.pappardelle.yml': `version: 1
state_colors:
  In Progress: '#f2c94c'
  In Review: '#f2c94c'
profiles:
  test:
    display_name: Test
`,
		'.pappardelle.local.yml': `version: 1
state_colors:
  In Review: cyan
  Done: '#74d09f'
`,
	});

	try {
		const config = loadConfigFromPaths({projectDir: dir});
		expect(getStateColors(config)).toStrictEqual({
			'In Progress': '#f2c94c',
			'In Review': 'cyan',
			Done: '#74d09f',
		});
	} finally {
		cleanup();
	}
});

test('a local layer can add state_colors when the project layer has none', () => {
	const {dir, cleanup} = setupTempDir({
		'.pappardelle.yml': `version: 1
profiles:
  test:
    display_name: Test
`,
		'.pappardelle.local.yml': `version: 1
state_colors:
  In Review: cyan
`,
	});

	try {
		const config = loadConfigFromPaths({projectDir: dir});
		expect(getStateColors(config)).toStrictEqual({'In Review': 'cyan'});
	} finally {
		cleanup();
	}
});

test('an invalid color in a merged layer fails validation', () => {
	const {dir, cleanup} = setupTempDir({
		'.pappardelle.yml': `version: 1
state_colors:
  Done: '#74d09f'
profiles:
  test:
    display_name: Test
`,
		'.pappardelle.local.yml': `version: 1
state_colors:
  Done: chartreuse
`,
	});

	try {
		expect(() => loadConfigFromPaths({projectDir: dir})).toThrow(
			ConfigValidationError,
		);
	} finally {
		cleanup();
	}
});

test('a case-variant state name across layers fails the duplicate check', () => {
	// deepMerge is generic and keys objects by their literal string, so
	// "In Progress" in the project layer and "in progress" in the local layer
	// survive as two entries rather than one overriding the other. The
	// duplicate check then rejects the merged config. Documented here because
	// hitting that error from two separate files is a surprising path: the fix
	// is to spell the name the same way in both layers.
	const {dir, cleanup} = setupTempDir({
		'.pappardelle.yml': `version: 1
state_colors:
  In Progress: '#f2c94c'
profiles:
  test:
    display_name: Test
`,
		'.pappardelle.local.yml': `version: 1
state_colors:
  in progress: cyan
`,
	});

	try {
		const error = thrownBy(
			() => loadConfigFromPaths({projectDir: dir}),
			ConfigValidationError,
		);
		expect(error?.errors).toStrictEqual([
			'state_colors: duplicate state name "in progress" (names are matched case-insensitively)',
		]);
	} finally {
		cleanup();
	}
});

// ============================================================================
// Schema errors name the file they come from
// ============================================================================

const opusProfile = `version: 1
agent_profiles:
  opus:
    command: claude
profiles:
  test:
    display_name: Test
`;

function schemaErrors(files: Record<string, string>): string[] {
	const dir = tempDir('pappardelle-merge-');
	writeFiles(dir, files);
	try {
		loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		return [];
	} catch (error) {
		if (error instanceof ConfigValidationError) return error.errors;
		throw error;
	}
}

test('a single-file config reports its schema errors without a file name', () => {
	expect(
		schemaErrors({
			'project/.pappardelle.yml': opusProfile.replace(
				'    command: claude\n',
				'    command: claude\n    model: 5\n',
			),
		}),
	).toStrictEqual(['agent_profiles.opus.model: must be a string']);
});

test('a schema error from the local file is labelled with it', () => {
	expect(
		schemaErrors({
			'project/.pappardelle.yml': opusProfile,
			'project/.pappardelle.local.yml':
				'agent_profiles:\n  opus:\n    model: 5\n',
		}),
	).toStrictEqual([
		'.pappardelle.local.yml: agent_profiles.opus.model: must be a string',
	]);
});

test('a schema error from the home file is labelled with it', () => {
	expect(
		schemaErrors({
			'home/.pappardelle.yml': 'agent_profiles:\n  opus:\n    model: 5\n',
			'project/.pappardelle.yml': opusProfile,
		}),
	).toStrictEqual([
		'~/.pappardelle/.pappardelle.yml: agent_profiles.opus.model: must be a string',
	]);
});

test('an error no single file causes stays unlabelled', () => {
	expect(
		schemaErrors({
			'home/.pappardelle.yml': 'team_prefix: ABC\n',
			'project/.pappardelle.yml': 'profiles: {}\n',
		}),
	).toStrictEqual(['version: must be 1']);
});

test('a bad value shadowed by a good one in a higher file is no error', () => {
	expect(
		schemaErrors({
			'project/.pappardelle.yml': opusProfile.replace(
				'    command: claude\n',
				'    command: claude\n    model: 5\n',
			),
			'project/.pappardelle.local.yml':
				'agent_profiles:\n  opus:\n    model: opus\n',
		}),
	).toStrictEqual([]);
});

// Leaving the home file out removes the profiles default_profile is checked
// against, but home sets no default_profile, so it is not the file to fix.
test('an error is not labelled with a file that does not set its key', () => {
	expect(
		schemaErrors({
			'home/.pappardelle.yml':
				'version: 1\nprofiles:\n  main:\n    display_name: Main\n',
			'project/.pappardelle.yml': 'default_profile: nope\n',
			'project/.pappardelle.local.yml': 'default_profile: nope\n',
		}),
	).toStrictEqual(['default_profile: profile "nope" not found in profiles']);
	expect(
		schemaErrors({
			'home/.pappardelle.yml': 'version: 1\ndefault_profile: nope\n',
			'project/.pappardelle.yml':
				'profiles:\n  main:\n    display_name: Main\n',
			'project/.pappardelle.local.yml': 'default_profile: nope\n',
		}),
	).toStrictEqual(['default_profile: profile "nope" not found in profiles']);
});

test('an error is not labelled with a file whose value a higher file overrides', () => {
	expect(
		schemaErrors({
			'home/.pappardelle.yml':
				'version: 1\ndefault_profile: main\nprofiles:\n  main:\n    display_name: Main\n',
			'project/.pappardelle.yml': 'default_profile: nope\n',
			'project/.pappardelle.local.yml': 'default_profile: nope\n',
		}),
	).toStrictEqual(['default_profile: profile "nope" not found in profiles']);
});

// The key the error names is missing everywhere, so the file to fix is the
// one that sets the nearest key around it.
test('an error about a missing key is labelled with the file that sets its parent', () => {
	expect(
		schemaErrors({
			'project/.pappardelle.yml': opusProfile,
			'project/.pappardelle.local.yml': 'issue_tracker:\n  provider: jira\n',
		}),
	).toStrictEqual([
		'.pappardelle.local.yml: issue_tracker.base_url: required when provider is "jira"',
	]);
	expect(
		schemaErrors({
			'project/.pappardelle.yml': opusProfile,
			'project/.pappardelle.local.yml':
				'agent_profiles:\n  foo:\n    model: opus\n',
		}),
	).toStrictEqual([
		'.pappardelle.local.yml: agent_profiles.foo.command: required non-empty string',
	]);
});

test('an error under a name with a dot is labelled with its file', () => {
	expect(
		schemaErrors({
			'home/.pappardelle.yml': 'agent_profiles:\n  gpt-4.1:\n    command: 1\n',
			'project/.pappardelle.yml': opusProfile,
			'project/.pappardelle.local.yml':
				'agent_profiles:\n  codex:\n    command: codex\n',
		}),
	).toStrictEqual([
		'~/.pappardelle/.pappardelle.yml: agent_profiles.gpt-4.1.command: required non-empty string',
	]);
	expect(
		schemaErrors({
			'project/.pappardelle.yml': opusProfile.replace(
				'    command: claude\n',
				'    command: claude\n  gpt-4:\n    command: codex\n',
			),
			'project/.pappardelle.local.yml':
				'agent_profiles:\n  gpt-4.1:\n    command: codex\n    model: 5\n',
		}),
	).toStrictEqual([
		'.pappardelle.local.yml: agent_profiles.gpt-4.1.model: must be a string',
	]);
});

test('keybindings that are not a list of bindings fail validation, not the merge', () => {
	for (const [local, expected] of [
		[
			'keybindings: nope\n',
			'.pappardelle.local.yml: keybindings: must be an array',
		],
		['keybindings:\n  - ~\n', 'keybindings[0]: must be a map'],
	] as const) {
		const errors = schemaErrors({
			'project/.pappardelle.yml': `${opusProfile}keybindings:
  - key: x
    name: X
    run: echo x
`,
			'project/.pappardelle.local.yml': local,
		});
		expect(errors).toStrictEqual([expected]);
	}
});

test('a bad keybinding in a higher file stays unlabelled', () => {
	expect(
		schemaErrors({
			'project/.pappardelle.yml': `${opusProfile}keybindings:
  - key: x
    name: X
    run: echo x
`,
			'project/.pappardelle.local.yml': `keybindings:
  - key: q
    name: Q
    run: echo q
`,
		}),
	).toStrictEqual(['keybindings[1].key: "q" conflicts with built-in shortcut']);
});

test('a keybinding error names no file, since merging re-indexes the bindings', () => {
	expect(
		schemaErrors({
			'home/.pappardelle.yml': `keybindings:
  - key: a
    name: A
    run: echo a
  - key: b
    run: echo b
`,
			'project/.pappardelle.yml': `${opusProfile}keybindings:
  - key: b
    run: echo b
`,
			'project/.pappardelle.local.yml': `keybindings:
  - key: a
    disabled: true
  - key: x
    name: X
    run: echo x
`,
		}),
	).toStrictEqual(['keybindings[0].name: required string field']);
});

test('a layer that repeats a state name verbatim overrides it cleanly', () => {
	const {dir, cleanup} = setupTempDir({
		'.pappardelle.yml': `version: 1
state_colors:
  In Progress: '#f2c94c'
profiles:
  test:
    display_name: Test
`,
		'.pappardelle.local.yml': `version: 1
state_colors:
  In Progress: cyan
`,
	});

	try {
		const config = loadConfigFromPaths({projectDir: dir});
		expect(getStateColors(config)).toStrictEqual({'In Progress': 'cyan'});
	} finally {
		cleanup();
	}
});

// ============================================================================
// loadConfigFromPaths — worktree fallback (pappardelle-xbe)
// ============================================================================
//
// `.pappardelle.yml` is excluded rather than committed, so a linked worktree
// has none and only the main checkout does. `.pappardelle.local.yml` is the
// reverse: workspace setup copies it into each worktree. Both facts have to
// hold at once, which is why the two layers resolve per file rather than per
// directory.

test('loadConfigFromPaths falls back to the main checkout for a missing project config', () => {
	const {dir, cleanup} = setupTempDir({
		'main/.pappardelle.yml': `version: 1
team_prefix: MAIN
profiles:
  hive:
    display_name: Hive
`,
		'worktree/.keep': '',
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'worktree'),
			fallbackProjectDir: () => path.join(dir, 'main'),
		});
		expect(getTeamPrefix(config)).toBe('MAIN');
		expect(config.profiles['hive']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test("loadConfigFromPaths prefers the worktree's own local override", () => {
	const {dir, cleanup} = setupTempDir({
		'main/.pappardelle.yml': `version: 1
team_prefix: MAIN
profiles:
  hive:
    display_name: Hive
`,
		'main/.pappardelle.local.yml': `team_prefix: MAINLOCAL
`,
		'worktree/.pappardelle.local.yml': `team_prefix: WTLOCAL
`,
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'worktree'),
			fallbackProjectDir: () => path.join(dir, 'main'),
		});
		// Project layer came from the main checkout, local layer from the worktree.
		expect(getTeamPrefix(config)).toBe('WTLOCAL');
		expect(config.profiles['hive']).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths without a fallback behaves exactly as before', () => {
	const {dir, cleanup} = setupTempDir({
		'main/.pappardelle.yml': `version: 1
profiles:
  hive:
    display_name: Hive
`,
		'worktree/.keep': '',
	});
	try {
		expect(() =>
			loadConfigFromPaths({projectDir: path.join(dir, 'worktree')}),
		).toThrow(ConfigNotFoundError);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths never resolves the fallback when the project dir has every layer', () => {
	const {dir, cleanup} = setupTempDir({
		'worktree/.pappardelle.yml': `version: 1
team_prefix: WT
profiles:
  hive:
    display_name: Hive
`,
		'worktree/.pappardelle.local.yml': `team_prefix: WTLOCAL
`,
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'worktree'),
			fallbackProjectDir() {
				throw new Error('fallback resolved');
			},
		});
		expect(getTeamPrefix(config)).toBe('WTLOCAL');
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths merges agent profile env per variable across layers', () => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
profiles: {}
agent_profile: opus
agent_profiles:
  opus:
    command: claude
    env:
      CODE_MODE: '1'
      SHARED: home
`,
		'project/.pappardelle.yml': `version: 1
agent_profiles:
  opus:
    env:
      SHARED: repo
      EXTRA: 'a b'
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		expect(getAgentProfile(config).env).toStrictEqual({
			CODE_MODE: '1',
			SHARED: 'repo',
			EXTRA: 'a b',
		});
	} finally {
		cleanup();
	}
});

// ============================================================================
// experimental.sqliteState: home layer only
// ============================================================================

const minimalConfig = `version: 1
profiles:
  t:
    display_name: T
`;
const sqliteStateOn = `experimental:
  sqliteState: true
`;

test('experimental.sqliteState is accepted from the home config', () => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': minimalConfig + sqliteStateOn,
	});
	try {
		const config = loadConfigFromPaths({homeConfigDir: path.join(dir, 'home')});
		expect(config.experimental?.sqliteState).toBe(true);
		expect(readHomeSqliteState(path.join(dir, 'home'))).toBe(true);
	} finally {
		cleanup();
	}
});

for (const file of ['.pappardelle.yml', '.pappardelle.local.yml']) {
	test(`experimental.sqliteState in ${file} is rejected by name`, () => {
		const {dir, cleanup} = setupTempDir({
			'home/.pappardelle.yml': minimalConfig,
			[`project/${file}`]: sqliteStateOn,
		});
		try {
			const error = thrownBy(
				() =>
					loadConfigFromPaths({
						homeConfigDir: path.join(dir, 'home'),
						projectDir: path.join(dir, 'project'),
					}),
				ConfigValidationError,
			);
			expect(
				error?.message.includes(
					`${file}: experimental.sqliteState can only be set in ~/.pappardelle/.pappardelle.yml`,
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});
}

test('the home flag is false when the home config leaves it out or is missing', () => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': minimalConfig + sqliteStateOn,
		'bare/.pappardelle.yml': minimalConfig,
	});
	try {
		expect(readHomeSqliteState(path.join(dir, 'home'))).toBe(true);
		expect(readHomeSqliteState(path.join(dir, 'bare'))).toBe(false);
		expect(readHomeSqliteState(path.join(dir, 'missing'))).toBe(false);
		expect(
			getRecentErrors().filter(entry =>
				entry.message.includes(path.join(dir, 'missing')),
			),
		).toStrictEqual([]);
	} finally {
		cleanup();
	}
});

test('a home config that does not parse leaves the flag off and says so', () => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': 'experimental: {sqliteState: true',
	});
	try {
		expect(readHomeSqliteState(path.join(dir, 'home'))).toBe(false);
		const warnings = getRecentErrors().filter(entry =>
			entry.message.includes(path.join(dir, 'home', '.pappardelle.yml')),
		);
		expect(warnings).toMatchObject([{level: 'warn'}]);
		expect(warnings.length).toBe(1);
		expect(warnings[0]!.message).toMatch(
			/Could not read experimental\.sqliteState/,
		);
		expect(warnings[0]!.error).toBeTruthy();
	} finally {
		cleanup();
	}
});

test('experimental.sqliteState must be a boolean', () => {
	const error = thrownBy(
		() =>
			validateConfig({
				version: 1,
				profiles: {t: {display_name: 'T'}},
				experimental: {sqliteState: 'yes'},
			}),
		ConfigValidationError,
	);
	expect(
		error?.message.includes('experimental.sqliteState: must be a boolean'),
	).toBe(true);
});
