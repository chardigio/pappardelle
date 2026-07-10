import test from 'ava';
import type {PappardelleConfig, Profile, KeybindingConfig} from './config.ts';
import {
	matchProfiles,
	matchProfileByProject,
	getProfileDefaultProject,
	getTeamPrefix,
	getProfileTeamPrefix,
	getProfileVcsLabel,
	getProfileEmoji,
	resolvePendingProfileEmoji,
	getInitializationCommand,
	getDangerouslySkipPermissions,
	getKeybindings,
	getDefaultProfile,
	getIssueWatchlist,
	getResolvedWatchlists,
	getAutoRemoveWhenDone,
	getCompanionCommand,
	DEFAULT_COMPANION_COMMAND,
	repoNameFromGitCommonDir,
	qualifyMainBranch,
	validateConfig,
	buildWorkspaceTemplateVars,
	ConfigValidationError,
	RESERVED_KEYS,
	NON_OVERRIDABLE_KEYS,
	DEFAULT_KEYBINDING_KEYS,
	RESERVED_VAR_NAMES,
	mergeKeybindings,
	determineProfileForInput,
	DEFERRED_PROFILE_DISPLAY_NAME,
} from './config.ts';

// Helper to create a minimal profile
function createProfile(keywords: string[], displayName: string): Profile {
	return {
		keywords,
		display_name: displayName,
	};
}

// Helper to create a test config
function createConfig(
	profiles: Record<string, Profile>,
	defaultProfile?: string,
	teamPrefix?: string,
): PappardelleConfig {
	return {
		version: 1,
		default_profile: defaultProfile,
		team_prefix: teamPrefix,
		profiles,
	};
}

// ============================================================================
// Team Prefix Tests
// ============================================================================

test('getTeamPrefix returns configured team_prefix', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
		'ENG',
	);
	t.is(getTeamPrefix(config), 'ENG');
});

test('getTeamPrefix returns default STA when not configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.is(getTeamPrefix(config), 'STA');
});

test('getTeamPrefix uppercases the team prefix', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
		'eng',
	);
	t.is(getTeamPrefix(config), 'ENG');
});

// ============================================================================
// Per-Profile Team Prefix Tests
// ============================================================================

test('getProfileTeamPrefix returns profile team_prefix when set', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		team_prefix: 'OTH',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile', 'STA');
	t.is(getProfileTeamPrefix(profile, config), 'OTH');
});

test('getProfileTeamPrefix falls back to global team_prefix', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile', 'ENG');
	t.is(getProfileTeamPrefix(profile, config), 'ENG');
});

test('getProfileTeamPrefix falls back to STA when neither set', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile');
	t.is(getProfileTeamPrefix(profile, config), 'STA');
});

test('getProfileTeamPrefix uppercases profile team_prefix', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		team_prefix: 'oth',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile', 'STA');
	t.is(getProfileTeamPrefix(profile, config), 'OTH');
});

test('getProfileTeamPrefix prefers profile over global', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		team_prefix: 'PROJ',
	};
	const config = createConfig(
		{'test-profile': profile},
		'test-profile',
		'GLOBAL',
	);
	t.is(getProfileTeamPrefix(profile, config), 'PROJ');
});

// ============================================================================
// Profile emoji + default_emoji Tests
// ============================================================================

test('getProfileEmoji returns profile emoji when set', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		emoji: '🍝',
	};
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'test',
		default_emoji: '🍕',
		profiles: {test: profile},
	};
	t.is(getProfileEmoji(profile, config), '🍝');
});

test('getProfileEmoji falls back to default_emoji when profile has none', t => {
	const profile: Profile = {keywords: ['test'], display_name: 'Test'};
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'test',
		default_emoji: '🍕',
		profiles: {test: profile},
	};
	t.is(getProfileEmoji(profile, config), '🍕');
});

test('getProfileEmoji returns undefined when neither is set', t => {
	const profile: Profile = {keywords: ['test'], display_name: 'Test'};
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'test',
		profiles: {test: profile},
	};
	t.is(getProfileEmoji(profile, config), undefined);
});

test('getProfileEmoji uses default_emoji when profile is undefined', t => {
	const config: PappardelleConfig = {
		version: 1,
		default_emoji: '🍕',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.is(getProfileEmoji(undefined, config), '🍕');
});

test('validateConfig rejects non-string default_emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: 123,
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('default_emoji'));
});

test('validateConfig accepts empty-string default_emoji (blank slot)', t => {
	// Empty string means "reserve the emoji slot but render nothing in it",
	// keeping rows aligned when some profiles have an emoji and others don't.
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: '',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts valid default_emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: '🍝',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-string profile emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: 42},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('profiles.test.emoji'));
});

test('validateConfig accepts empty-string profile emoji (blank slot)', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: ''},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts valid profile emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: '🚀'},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// Regression: a config with no emoji fields anywhere — neither
// `default_emoji` nor any profile `emoji:` — must produce `undefined` from
// getProfileEmoji for every profile. This is what the SpaceListItem renderer
// keys off of to skip the emoji slot entirely and render the row exactly as
// it did on master. If this ever returns a string, every existing user gets
// an unexpected blank slot in their TUI on the next upgrade.
test('emoji-free config: getProfileEmoji returns undefined for every profile', t => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A'},
			b: {keywords: ['b'], display_name: 'B'},
			c: {keywords: ['c'], display_name: 'C'},
		},
	};
	for (const profile of Object.values(config.profiles)) {
		t.is(
			getProfileEmoji(profile, config),
			undefined,
			'no emoji fields anywhere should yield undefined (master UI preserved)',
		);
	}

	// Also: undefined profile (e.g., main worktree path) must stay undefined.
	t.is(getProfileEmoji(undefined, config), undefined);
});

test('partial emoji config: profiles without emoji fall back to default_emoji', t => {
	// Sanity check the inverse: as soon as ANY emoji field is set, unmatched
	// profiles inherit the default. (This is the "blank slot" case Charlie
	// uses — default_emoji = "" means "reserve the slot but render nothing".)
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	t.is(getProfileEmoji(config.profiles['a']!, config), '🎸');
	t.is(getProfileEmoji(config.profiles['b']!, config), '');
});

// Footgun guard: if the user sets an `emoji:` on some profiles but forgets
// `default_emoji`, we auto-promote to `''` (blank slot) for the rest so
// rows stay aligned. Without this, one profile's emoji would silently
// jut every other row's row out of alignment by 3 cells.
test('footgun guard: any profile emoji + no default_emoji → "" for unset profiles', t => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
			b: {keywords: ['b'], display_name: 'B'}, // no emoji
			c: {keywords: ['c'], display_name: 'C'}, // no emoji
		},
	};
	t.is(getProfileEmoji(config.profiles['a']!, config), '🎸');
	t.is(
		getProfileEmoji(config.profiles['b']!, config),
		'',
		'unset profile should inherit auto-blank slot so rows line up',
	);
	t.is(
		getProfileEmoji(config.profiles['c']!, config),
		'',
		'unset profile should inherit auto-blank slot so rows line up',
	);
	t.is(
		getProfileEmoji(undefined, config),
		'',
		'main worktree (undefined profile) should also inherit the auto-blank slot',
	);
});

// Same guard applies when the profile's emoji is explicitly empty — the
// "any other profile has an emoji" check counts empty-string as set.
test('footgun guard: explicit "" on one profile still promotes unset siblings', t => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: ''},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	t.is(getProfileEmoji(config.profiles['a']!, config), '');
	t.is(getProfileEmoji(config.profiles['b']!, config), '');
});

// ============================================================================
// resolvePendingProfileEmoji Tests
// ============================================================================
//
// Pending placeholder rows (`Starting new session…`, `Opening…`, `Watchlist:
// <title>`) need to reserve the same emoji slot as real rows whenever any
// emoji is configured, so the Claude thinking icon stays vertically aligned.
// When no emoji is configured anywhere, the slot must NOT be reserved or
// the TUI changes shape for users who never opted into the feature.

// Off-by-default regression: the single most important case. If this ever
// flips, every existing user gets a surprise blank slot in their TUI on
// the next upgrade — exactly the regression the emoji rail feature was
// careful to avoid in STA-924.
test('resolvePendingProfileEmoji: emoji-free config → undefined regardless of profileName', t => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A'},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	t.is(resolvePendingProfileEmoji(config, null), undefined);
	t.is(resolvePendingProfileEmoji(config, undefined), undefined);
	t.is(resolvePendingProfileEmoji(config, 'a'), undefined);
	t.is(resolvePendingProfileEmoji(config, 'unknown-profile'), undefined);
});

test('resolvePendingProfileEmoji: null config → undefined (load failure path)', t => {
	t.is(resolvePendingProfileEmoji(null, null), undefined);
	t.is(resolvePendingProfileEmoji(null, 'whatever'), undefined);
});

test('resolvePendingProfileEmoji: known profileName → that profile emoji', t => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '🍕',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	t.is(resolvePendingProfileEmoji(config, 'a'), '🎸');
});

test('resolvePendingProfileEmoji: known profileName w/o emoji → default_emoji fallback', t => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '🍕',
		profiles: {
			a: {keywords: ['a'], display_name: 'A'}, // no emoji on profile
		},
	};
	t.is(resolvePendingProfileEmoji(config, 'a'), '🍕');
});

test('resolvePendingProfileEmoji: no profileName, default_emoji set → default_emoji', t => {
	// Description-route ("Starting new session…") never knows the profile
	// upfront — the user just typed free text. Must still pick up the
	// default emoji so the slot is reserved.
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '🍝',
		profiles: {a: {keywords: ['a'], display_name: 'A'}},
	};
	t.is(resolvePendingProfileEmoji(config, null), '🍝');
	t.is(resolvePendingProfileEmoji(config, undefined), '🍝');
});

test('resolvePendingProfileEmoji: no profileName, footgun guard active → "" blank slot', t => {
	// Watchlist auto-spawn doesn't pass a profileName but other profiles
	// have emoji set; the helper must reserve a blank slot so the pending
	// row aligns with its emoji-bearing neighbors.
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	t.is(resolvePendingProfileEmoji(config, null), '');
});

test('resolvePendingProfileEmoji: unknown profileName → falls back as if undefined', t => {
	// If the profileName the spawn site passes doesn't exist (config drift,
	// renamed profile mid-flight, etc.), we must not crash and we must still
	// reserve the slot when emoji machinery is in use. Cover both fallback
	// branches explicitly so a future refactor that special-cases unknown
	// profileName can't silently regress one path while leaving the other
	// passing.
	const configWithDefault: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '🍕',
		profiles: {a: {keywords: ['a'], display_name: 'A'}},
	};
	t.is(resolvePendingProfileEmoji(configWithDefault, 'does-not-exist'), '🍕');

	// Footgun-guard path: no `default_emoji` but a profile has `emoji:` →
	// `''` blank slot for unknown profileName too.
	const configWithFootgun: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
		},
	};
	t.is(resolvePendingProfileEmoji(configWithFootgun, 'does-not-exist'), '');
});

// ============================================================================
// Profile team_prefix Validation Tests
// ============================================================================

test('validateConfig rejects non-string profile team_prefix', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				team_prefix: 123, // Invalid: should be a string
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('profiles.test.team_prefix: must be a string'),
	);
});

test('validateConfig accepts valid string profile team_prefix', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				team_prefix: 'OTH',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// Profile vars Validation Tests
// ============================================================================

test('validateConfig rejects non-string vars value', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {IOS_APP_DIR: 123},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('profiles.test.vars.IOS_APP_DIR: must be a string'),
	);
});

test('validateConfig accepts valid string vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {IOS_APP_DIR: '_ios/MyApp', SCHEME: 'MyApp'},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts profile without vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-object vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: 'not an object',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('profiles.test.vars: must be an object'));
});

test('validateConfig rejects null vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: null,
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('profiles.test.vars: must be an object'));
});

test('validateConfig accepts empty vars object', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig reports multiple invalid vars values', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {FOO: 123, BAR: true, VALID: 'ok'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.FOO: must be a string'));
	t.truthy(error?.message.includes('vars.BAR: must be a string'));
	// VALID should not appear in error
	t.falsy(error?.message.includes('vars.VALID'));
});

test('validateConfig rejects reserved var name PATH', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {PATH: '/usr/bin'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.PATH: reserved name'));
});

test('validateConfig rejects reserved var name HOME', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {HOME: '/tmp'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.HOME: reserved name'));
});

test('validateConfig rejects reserved built-in template var ISSUE_KEY', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {ISSUE_KEY: 'STA-123'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.ISSUE_KEY: reserved name'));
});

test('validateConfig rejects reserved built-in template var WORKTREE_PATH', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {WORKTREE_PATH: '/tmp/wt'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.WORKTREE_PATH: reserved name'));
});

test('validateConfig allows non-reserved var names', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {
					IOS_APP_DIR: '_ios/MyApp',
					BUNDLE_ID: 'com.example.app',
					SCHEME: 'MyApp',
					MY_CUSTOM_VAR: 'hello',
				},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('RESERVED_VAR_NAMES includes critical shell variables', t => {
	for (const name of ['PATH', 'HOME', 'IFS', 'SHELL', 'USER', 'PWD', 'TERM']) {
		t.true(RESERVED_VAR_NAMES.has(name), `${name} should be reserved`);
	}
});

test('RESERVED_VAR_NAMES includes built-in template variables', t => {
	for (const name of [
		'ISSUE_KEY',
		'WORKTREE_PATH',
		'REPO_ROOT',
		'REPO_NAME',
		'SCRIPT_DIR',
		'PR_URL',
		'VCS_LABEL',
	]) {
		t.true(RESERVED_VAR_NAMES.has(name), `${name} should be reserved`);
	}
});

// ============================================================================
// buildWorkspaceTemplateVars Tests
// ============================================================================

// Test config for buildWorkspaceTemplateVars tests (self-contained, no disk dependency)
const templateVarsTestConfig = createConfig(
	{
		'stardust-jams': {
			keywords: ['stardust', 'jams', 'music'],
			display_name: 'Stardust Jams',
			vars: {
				IOS_APP_DIR: '_ios/stardust-jams',
				BUNDLE_ID: 'io.stardustlabs.stardust',
				SCHEME: 'stardust-jams',
			},
			vcs: {label: 'stardust_jams'},
		},
		pappardelle: {
			keywords: ['pappardelle'],
			display_name: 'Pappardelle',
		},
	},
	'pappardelle',
	'STA',
);

test('buildWorkspaceTemplateVars sets base variables', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		undefined,
		templateVarsTestConfig,
	);
	t.is(vars.ISSUE_KEY, 'STA-999');
	t.is(vars.WORKTREE_PATH, '/tmp/worktree');
	t.truthy(vars.REPO_ROOT);
	t.truthy(vars.REPO_NAME);
	t.truthy(vars.SCRIPT_DIR);
});

test('buildWorkspaceTemplateVars merges profile vars when title matches', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		'fix stardust jams bug',
		templateVarsTestConfig,
	);
	// Profile vars from stardust-jams profile should be merged
	t.is(vars['IOS_APP_DIR'], '_ios/stardust-jams');
	t.is(vars['BUNDLE_ID'], 'io.stardustlabs.stardust');
	t.is(vars['SCHEME'], 'stardust-jams');
});

test('buildWorkspaceTemplateVars sets VCS label from matched profile', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		'fix stardust jams bug',
		templateVarsTestConfig,
	);
	t.is(vars.VCS_LABEL, 'stardust_jams');
	t.is(vars.GITHUB_LABEL, 'stardust_jams');
});

test('buildWorkspaceTemplateVars falls back to default profile when no title match', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		'zzz nonexistent topic',
		templateVarsTestConfig,
	);
	// Default profile is "pappardelle" which has no vars, so custom vars should be absent
	t.is(vars['IOS_APP_DIR'], undefined);
	t.is(vars['BUNDLE_ID'], undefined);
});

test('buildWorkspaceTemplateVars falls back to default profile when no title provided', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		undefined,
		templateVarsTestConfig,
	);
	// No title = no match = falls back to default profile (pappardelle, no vars)
	t.is(vars['IOS_APP_DIR'], undefined);
});

test('buildWorkspaceTemplateVars does not overwrite base vars with profile vars', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		'fix stardust jams bug',
		templateVarsTestConfig,
	);
	// Base vars should remain even though profile vars were merged
	t.is(vars.ISSUE_KEY, 'STA-999');
	t.is(vars.WORKTREE_PATH, '/tmp/worktree');
});

// ============================================================================
// Basic Matching Tests
// ============================================================================

test('matches exact keyword', t => {
	const config = createConfig({
		'test-profile': createProfile(['pappardelle'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'pappardelle');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'test-profile');
	t.deepEqual(matches[0]!.matchedKeywords, ['pappardelle']);
});

test('matches keyword case-insensitively', t => {
	const config = createConfig({
		'test-profile': createProfile(['Pappardelle'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'PAPPARDELLE');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'test-profile');
});

test('matches keyword within sentence', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle', 'tui', 'dow'], 'Pappardelle'),
	});

	const matches = matchProfiles(
		config,
		'fix the pappardelle profile detection',
	);
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
	t.deepEqual(matches[0]!.matchedKeywords, ['pappardelle']);
});

test('returns empty array when no match', t => {
	const config = createConfig({
		'test-profile': createProfile(['foo', 'bar'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'baz qux');
	t.is(matches.length, 0);
});

// ============================================================================
// Multiple Profile Tests (Priority/Tie-breaking)
// ============================================================================

test('prioritizes profile with more keyword matches', t => {
	const config = createConfig({
		'profile-a': createProfile(['foo'], 'Profile A'),
		'profile-b': createProfile(['foo', 'bar'], 'Profile B'),
	});

	const matches = matchProfiles(config, 'foo bar');
	t.is(matches.length, 2);
	t.is(matches[0]!.name, 'profile-b');
	t.is(matches[0]!.score, 2);
});

test('returns pappardelle for pappardelle-related prompts, not stardust-jams', t => {
	// This test reproduces the exact bug from the issue
	const config = createConfig({
		'stardust-jams': createProfile(
			[
				'stardust',
				'jams',
				'music',
				'spotify',
				'playlist',
				'album',
				'artist',
				'track',
				'recording',
			],
			'Stardust Jams',
		),
		pappardelle: createProfile(
			['pappardelle', 'tui', 'dow', 'idow', 'workspace', 'worktree'],
			'Pappardelle',
		),
	});

	const matches = matchProfiles(
		config,
		'test the profile detection logic in pappardelle',
	);
	t.true(matches.length >= 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('both profiles match when input contains prefixes for both', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	// "tracking" prefix-matches "track", "pappardelle" exact-matches "pappardelle"
	const matches = matchProfiles(config, 'pappardelle tracking test');
	t.is(matches.length, 2);
});

// ============================================================================
// Prefix Matching Tests
// ============================================================================

test('SHOULD match "track" keyword when input has "tracking"', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'tracking the issue');
	t.is(matches.length, 1, '"tracking" starts with "track" so it should match');
	t.is(matches[0]!.name, 'stardust-jams');
});

test('SHOULD match "record" keyword when input has "recording"', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['record'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'recording a video');
	t.is(
		matches.length,
		1,
		'"recording" starts with "record" so it should match',
	);
	t.is(matches[0]!.name, 'stardust-jams');
});

test('SHOULD NOT match "music" keyword when input has "mu"', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'mu test');
	t.is(matches.length, 0, '"mu" does not start with "music"');
});

test('SHOULD match exact word even with punctuation nearby', t => {
	const config = createConfig({
		'test-profile': createProfile(['pappardelle'], 'Test Profile'),
	});

	// Note: This depends on how we split words - may need adjustment
	const matches = matchProfiles(config, 'fix pappardelle,now');
	t.true(matches.length >= 1);
	t.is(matches[0]!.name, 'test-profile');
});

// ============================================================================
// Prefix Matching with Hyphens
// ============================================================================

test('"SHOP-" keyword matches "SHOP-313"', t => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	const matches = matchProfiles(config, 'working on SHOP-313 today');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'shop');
	t.deepEqual(matches[0]!.matchedKeywords, ['SHOP-']);
});

test('prefix keyword matches various suffixes', t => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	for (const input of ['SHOP-1', 'SHOP-999', 'SHOP-abc', 'fix SHOP-42 bug']) {
		const matches = matchProfiles(config, input);
		t.is(matches.length, 1, `"SHOP-" should match "${input}"`);
		t.is(matches[0]!.name, 'shop');
	}
});

test('prefix keyword is case-insensitive', t => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	const matches = matchProfiles(config, 'shop-42 is broken');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'shop');
});

test('hyphenated keyword does NOT match word missing the hyphen', t => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	// "shop" does not start with "shop-"
	const matches = matchProfiles(config, 'shop is broken');
	t.is(matches.length, 0, '"shop" does not start with "shop-"');
});

test('multiple prefix keywords can match from different profiles', t => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
		warehouse: createProfile(['WH-'], 'Warehouse'),
	});

	const matches = matchProfiles(config, 'SHOP-42 needs WH-7 stock');
	t.is(matches.length, 2);
});

// ============================================================================
// Keyword Buried Inside a Hyphen-Joined Input Word (STA-927)
// ============================================================================

test('keyword buried inside a hyphen-joined input word still matches', t => {
	// Regression for STA-927: "something-keyword-something" should match
	// keyword "keyword" — previously the input was treated as a single word
	// that did not start with the keyword, so it silently failed.
	const config = createConfig({
		'test-profile': createProfile(['keyword'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'something-keyword-something');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'test-profile');
	t.deepEqual(matches[0]!.matchedKeywords, ['keyword']);
});

test('keyword buried in hyphenated word matches case-insensitively', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'Fix-MUSIC-Bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
});

test('prefix keyword matches buried hyphen-joined sub-token (e.g. "spot" → "add-spotify")', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['spot'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'add-spotify-integration');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
});

test('multiple distinct keywords buried in same hyphen-joined word both match', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music', 'spotify'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'fix-music-spotify-bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.score, 2);
	t.deepEqual(matches[0]!.matchedKeywords.sort(), ['music', 'spotify']);
});

test('buried keyword does not bleed across whitespace word boundaries', t => {
	// "mu" is a sub-token of "mu-foo" but it does not start with "music",
	// so a profile keyworded "music" must not match.
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'mu-foo bar');
	t.is(matches.length, 0, '"mu" sub-token does not start with "music"');
});

test('regression: "shop" alone still does not match "SHOP-" keyword after hyphen-aware fix', t => {
	// Pin: the trailing-hyphen keyword "SHOP-" must still REJECT bare "shop"
	// inputs, even after the fix walks hyphen sub-tokens. This is what makes
	// "SHOP-" distinct from "SHOP" and prevents false-positive matches on
	// unrelated words like "shopping" or "shopkeeper".
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	t.is(matchProfiles(config, 'shop is broken').length, 0);
	t.is(matchProfiles(config, 'fix-shop-bug').length, 0);
});

test('regression: hyphen-aware fix still respects multi-word keyword adjacency in plain input', t => {
	// Pin existing whitespace-adjacency semantics for multi-word keywords.
	// The third assertion pins the *intentional* non-wiring of subTokens into
	// the multi-word branch: a hyphenated input like "fix-venue-page" must NOT
	// match keyword "venue page" today. If a future change extends the
	// multi-word branch to also walk sub-tokens, this assertion will go red
	// and force a deliberate decision instead of a silent behavior shift.
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	t.is(matchProfiles(config, 'venue detail page').length, 0);
	t.is(matchProfiles(config, 'fix the venue page').length, 1);
	t.is(
		matchProfiles(config, 'fix-venue-page').length,
		0,
		'hyphenated input does not bypass multi-word adjacency requirement',
	);
});

// ============================================================================
// Real-world Scenario Tests
// ============================================================================

test('pappardelle profile for dow/idow related prompts', t => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['stardust', 'jams', 'music'],
			'Stardust Jams',
		),
		pappardelle: createProfile(
			['pappardelle', 'tui', 'dow', 'idow'],
			'Pappardelle',
		),
	});

	t.is(matchProfiles(config, 'fix the dow script')[0]?.name, 'pappardelle');
	t.is(matchProfiles(config, 'idow is broken')[0]?.name, 'pappardelle');
	t.is(matchProfiles(config, 'update tui colors')[0]?.name, 'pappardelle');
});

test('stardust-jams profile for music-related prompts', t => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['stardust', 'jams', 'music', 'spotify', 'playlist'],
			'Stardust Jams',
		),
		pappardelle: createProfile(['pappardelle', 'tui', 'dow'], 'Pappardelle'),
	});

	t.is(
		matchProfiles(config, 'add spotify integration')[0]?.name,
		'stardust-jams',
	);
	t.is(
		matchProfiles(config, 'create new playlist feature')[0]?.name,
		'stardust-jams',
	);
	t.is(matchProfiles(config, 'fix music player bug')[0]?.name, 'stardust-jams');
});

test('king-bee profile for hive/spelling related prompts', t => {
	const config = createConfig({
		'king-bee': createProfile(
			['king', 'bee', 'hive', 'spelling', 'wordle'],
			'King Bee',
		),
		'stardust-jams': createProfile(
			['stardust', 'jams', 'music'],
			'Stardust Jams',
		),
	});

	t.is(matchProfiles(config, 'fix the hive puzzle')[0]?.name, 'king-bee');
	t.is(matchProfiles(config, 'spelling bee scoring bug')[0]?.name, 'king-bee');
});

test('no false positives from common words', t => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['track', 'album', 'artist'],
			'Stardust Jams',
		),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	// Words like "a", "the", "is", "it" should not match anything
	const matches = matchProfiles(config, 'a the is it and or');
	t.is(matches.length, 0);
});

// ============================================================================
// Multi-word Keyword Matching Tests
// ============================================================================

test('matches multi-word keyword as adjacent phrase', t => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix the venue page layout');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'venue-profile');
	t.deepEqual(matches[0]!.matchedKeywords, ['venue page']);
});

test('does NOT match multi-word keyword when words are non-adjacent', t => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'venue detail page');
	t.is(matches.length, 0);
});

test('does NOT match multi-word keyword when only partial words appear', t => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix venue layout');
	t.is(matches.length, 0);
});

test('matches multi-word keyword case-insensitively', t => {
	const config = createConfig({
		'venue-profile': createProfile(['Venue Page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix the VENUE PAGE bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'venue-profile');
});

test('matches mix of single-word and multi-word keywords', t => {
	const config = createConfig({
		'mixed-profile': createProfile(
			['venue page', 'map', 'location detail'],
			'Mixed Profile',
		),
	});

	const matches = matchProfiles(config, 'fix the venue page map');
	t.is(matches.length, 1);
	t.is(matches[0]!.score, 2);
	t.deepEqual(matches[0]!.matchedKeywords, ['venue page', 'map']);
});

test('multi-word keyword scores 1 like single-word keyword', t => {
	const config = createConfig({
		'profile-a': createProfile(['venue page'], 'Profile A'),
		'profile-b': createProfile(['venue'], 'Profile B'),
	});

	const matches = matchProfiles(config, 'venue page test');
	// Both should match; profile-a matches "venue page", profile-b matches "venue"
	t.is(matches.length, 2);
	// Both have score 1
	t.is(matches[0]!.score, 1);
	t.is(matches[1]!.score, 1);
});

test('multi-word keyword at start of input', t => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'venue page needs fixing');
	t.is(matches.length, 1);
});

test('multi-word keyword at end of input', t => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix the venue page');
	t.is(matches.length, 1);
});

test('multi-word keyword with punctuation between words in input', t => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	// Words separated by comma - the splitter should still produce adjacent words
	const matches = matchProfiles(config, 'fix venue,page layout');
	t.is(matches.length, 1);
});

test('three-word keyword matches', t => {
	const config = createConfig({
		'detail-profile': createProfile(['venue detail page'], 'Detail Profile'),
	});

	const matches = matchProfiles(config, 'fix the venue detail page layout');
	t.is(matches.length, 1);
	t.deepEqual(matches[0]!.matchedKeywords, ['venue detail page']);
});

test('three-word keyword does NOT match with wrong order', t => {
	const config = createConfig({
		'detail-profile': createProfile(['venue detail page'], 'Detail Profile'),
	});

	const matches = matchProfiles(config, 'venue page detail');
	t.is(matches.length, 0);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('empty keyword does not match any input', t => {
	const config = createConfig({
		'bad-profile': createProfile(['', '   '], 'Bad Profile'),
	});

	const matches = matchProfiles(config, 'anything here');
	t.is(matches.length, 0);
});

test('handles empty input', t => {
	const config = createConfig({
		'test-profile': createProfile(['foo'], 'Test Profile'),
	});

	const matches = matchProfiles(config, '');
	t.is(matches.length, 0);
});

test('handles whitespace-only input', t => {
	const config = createConfig({
		'test-profile': createProfile(['foo'], 'Test Profile'),
	});

	const matches = matchProfiles(config, '   \t\n  ');
	t.is(matches.length, 0);
});

test('handles single character input', t => {
	const config = createConfig({
		'test-profile': createProfile(['a'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'a');
	t.is(matches.length, 1);
});

test('handles hyphenated keywords', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['stardust-jams'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'fix stardust-jams bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
});

// ============================================================================
// Special Character Tests
// ============================================================================

test('matches keyword in parentheses', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix (pappardelle) bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with trailing parenthesis', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'pappardelle) is broken');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with leading parenthesis', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix (pappardelle today');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword in square brackets', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix [pappardelle] bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword in curly braces', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix {pappardelle} bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with forward slash', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix pappardelle/config issue');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with backslash', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix pappardelle\\config issue');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with single quotes', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, "fix 'pappardelle' bug");
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with double quotes', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix "pappardelle" bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with underscore prefix', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix _pappardelle module');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with underscore suffix', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix pappardelle_ module');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with hyphen prefix', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix -pappardelle option');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with at symbol', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix @pappardelle/cli bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with hash symbol', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '#pappardelle needs fix');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with backticks', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix `pappardelle` command');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword surrounded by multiple special chars', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix ["pappardelle"] bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with ampersand', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
		config: createProfile(['config'], 'Config'),
	});

	const matches = matchProfiles(config, 'pappardelle & config');
	t.is(matches.length, 2);
	t.true(matches.some(m => m.name === 'pappardelle'));
	t.true(matches.some(m => m.name === 'config'));
});

test('matches keyword with pipe symbol', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'pappardelle | grep something');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with angle brackets', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix <pappardelle> component');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with equals sign', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'profile=pappardelle issue');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with plus sign', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'pappardelle+config feature');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with percent sign', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '%pappardelle variable');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with caret', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '^pappardelle regex');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with asterisk', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '*pappardelle* important');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with tilde', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '~pappardelle path');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches keyword with dollar sign', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '$pappardelle environment var');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
});

test('matches multiple keywords with mixed special chars', t => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle', 'tui', 'dow'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '(pappardelle) [tui] {dow}');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
	t.is(matches[0]!.score, 3);
	t.deepEqual(matches[0]!.matchedKeywords.sort(), [
		'dow',
		'pappardelle',
		'tui',
	]);
});

// ============================================================================
// Keyword Enforcement (!) Tests
// ============================================================================

test('! after keyword enforces that profile', t => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['music', 'spotify', 'track'],
			'Stardust Jams',
		),
		'king-bee': createProfile(['bee', 'hive', 'spelling'], 'King Bee'),
	});

	// "music!" should enforce stardust-jams even though "bee" matches king-bee
	const matches = matchProfiles(config, 'fix the music! and bee stuff');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.true(matches[0]!.enforced);
});

test('! enforcement wins over higher-scoring non-enforced profile', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee', 'hive', 'spelling'], 'King Bee'),
	});

	// "music!" enforces stardust-jams even though king-bee has more keyword matches
	const matches = matchProfiles(config, 'music! bee hive spelling');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.true(matches[0]!.enforced);
});

test('! enforcement with prefix matching', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	// "tracking!" should enforce stardust-jams via prefix match on "track"
	const matches = matchProfiles(config, 'tracking! pappardelle issue');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.true(matches[0]!.enforced);
});

test('! enforcement is case-insensitive', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	const matches = matchProfiles(config, 'MUSIC! bee');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.true(matches[0]!.enforced);
});

test('! on non-keyword word falls back to normal matching', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	// "fix!" is not a keyword for any profile, so fall back to normal matching
	const matches = matchProfiles(config, 'fix! the music and bee');
	t.is(matches.length, 2);
	t.false(matches[0]!.enforced);
});

test('multiple ! keywords from same profile', t => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['music', 'spotify', 'track'],
			'Stardust Jams',
		),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	const matches = matchProfiles(config, 'music! spotify! bee');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.true(matches[0]!.enforced);
});

test('multiple ! keywords from different profiles returns both enforced', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	const matches = matchProfiles(config, 'music! bee!');
	t.is(matches.length, 2);
	t.true(matches[0]!.enforced);
	t.true(matches[1]!.enforced);
});

test('! alone without preceding word does not enforce', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, '! music');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.false(matches[0]!.enforced);
});

test('no ! in input means enforced is false', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'music player bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.false(matches[0]!.enforced);
});

test('! enforcement with hyphenated keyword', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['stardust-jams'], 'Stardust Jams'),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'stardust-jams! pappardelle bug');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'stardust-jams');
	t.true(matches[0]!.enforced);
});

test('real-world: enforce pappardelle over stardust-jams', t => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['stardust', 'jams', 'music', 'track', 'recording'],
			'Stardust Jams',
		),
		pappardelle: createProfile(
			['pappardelle', 'tui', 'dow', 'idow'],
			'Pappardelle',
		),
	});

	// Even though "recording" matches stardust-jams, pappardelle! enforces pappardelle
	const matches = matchProfiles(
		config,
		'pappardelle! recording keyword matching',
	);
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'pappardelle');
	t.true(matches[0]!.enforced);
});

// ============================================================================
// Repo Name from Git Common Dir Tests
// ============================================================================

test('repoNameFromGitCommonDir extracts repo name from main repo .git path', t => {
	t.is(
		repoNameFromGitCommonDir('/Users/charlie/cs/stardust-labs/.git'),
		'stardust-labs',
	);
});

test('repoNameFromGitCommonDir extracts repo name from worktree .git path', t => {
	// git common dir is always the main repo's .git, even from a worktree
	t.is(
		repoNameFromGitCommonDir('/Users/charlie/cs/my-project/.git'),
		'my-project',
	);
});

test('repoNameFromGitCommonDir handles trailing slash', t => {
	t.is(
		repoNameFromGitCommonDir('/Users/charlie/cs/stardust-labs/.git/'),
		'stardust-labs',
	);
});

test('repoNameFromGitCommonDir handles relative .git path', t => {
	// Edge case: relative path — dirname of ".git" is "."
	t.is(repoNameFromGitCommonDir('.git'), '.');
});

// ============================================================================
// getProfileVcsLabel Tests
// ============================================================================

test('getProfileVcsLabel returns vcs.label when set', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		vcs: {label: 'my_label'},
		github: {label: 'gh_label'},
	};
	t.is(getProfileVcsLabel(profile), 'my_label');
});

test('getProfileVcsLabel falls back to github.label', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		github: {label: 'gh_label'},
	};
	t.is(getProfileVcsLabel(profile), 'gh_label');
});

test('getProfileVcsLabel returns undefined when neither set', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
	};
	t.is(getProfileVcsLabel(profile), undefined);
});

test('getProfileVcsLabel prefers vcs.label over github.label', t => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		vcs: {label: 'vcs_first'},
		github: {label: 'gh_second'},
	};
	t.is(getProfileVcsLabel(profile), 'vcs_first');
});

// ============================================================================
// getInitializationCommand Tests
// ============================================================================

test('getInitializationCommand returns configured command', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	(config as Record<string, unknown>)['claude'] = {
		initialization_command: '/idow',
	};
	t.is(getInitializationCommand(config), '/idow');
});

test('getInitializationCommand returns empty string when not configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.is(getInitializationCommand(config), '');
});

test('getInitializationCommand returns empty string when claude section exists but no command', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	(config as Record<string, unknown>)['claude'] = {};
	t.is(getInitializationCommand(config), '');
});

// ============================================================================
// getDangerouslySkipPermissions Tests
// ============================================================================

test('getDangerouslySkipPermissions returns true when configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.claude = {dangerously_skip_permissions: true};
	t.is(getDangerouslySkipPermissions(config), true);
});

test('getDangerouslySkipPermissions returns false when configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.claude = {dangerously_skip_permissions: false};
	t.is(getDangerouslySkipPermissions(config), false);
});

test('getDangerouslySkipPermissions returns false when not configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.is(getDangerouslySkipPermissions(config), false);
});

test('getDangerouslySkipPermissions returns false when claude section exists but no flag', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.claude = {initialization_command: '/idow'};
	t.is(getDangerouslySkipPermissions(config), false);
});

test('validateConfig rejects non-boolean dangerously_skip_permissions', t => {
	const rawConfig = {
		version: 1,
		default_profile: 'test',
		claude: {dangerously_skip_permissions: 'yes'},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = t.throws(() => validateConfig(rawConfig), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('dangerously_skip_permissions: must be a boolean'),
	);
});

test('validateConfig accepts boolean dangerously_skip_permissions', t => {
	const rawConfig = {
		version: 1,
		default_profile: 'test',
		claude: {dangerously_skip_permissions: true},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(rawConfig));
});

// ============================================================================
// qualifyMainBranch Tests
// ============================================================================

test('qualifyMainBranch combines repo name and branch', t => {
	t.is(qualifyMainBranch('stardust-labs', 'master'), 'stardust-labs-master');
});

test('qualifyMainBranch works with main branch', t => {
	t.is(qualifyMainBranch('pappa-chex', 'main'), 'pappa-chex-main');
});

test('qualifyMainBranch works with arbitrary branch names', t => {
	t.is(qualifyMainBranch('my-repo', 'develop'), 'my-repo-develop');
});

// ============================================================================
// Keybinding Tests
// ============================================================================

test('getKeybindings returns empty array when not configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.deepEqual(getKeybindings(config), []);
});

test('getKeybindings returns configured keybindings', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.keybindings = [
		{key: 'b', name: 'Build', run: 'make build'},
		{key: 't', name: 'Test', run: 'make test'},
	];
	const bindings = getKeybindings(config);
	t.is(bindings.length, 2);
	t.is(bindings[0]!.key, 'b');
	t.is(bindings[0]!.name, 'Build');
	t.is(bindings[1]!.key, 't');
});

test('validateConfig accepts valid keybindings', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{key: 'b', name: 'Build', run: 'make build'},
			{key: 't', name: 'Test', run: 'make test'},
		],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects keybinding with multi-character key', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [{key: 'bb', name: 'Build', run: 'make build'}],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('must be a single character'));
});

test('validateConfig rejects keybinding with non-overridable reserved key', t => {
	for (const reservedKey of NON_OVERRIDABLE_KEYS) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key: reservedKey, name: 'Conflict', run: 'echo conflict'}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		const error = t.throws(() => validateConfig(raw), {
			instanceOf: ConfigValidationError,
		});
		t.truthy(error?.message.includes('conflicts with built-in shortcut'));
	}
});

test('validateConfig accepts keybinding that overrides a default key', t => {
	for (const defaultKey of DEFAULT_KEYBINDING_KEYS) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [
				{
					key: defaultKey,
					name: `Custom ${defaultKey}`,
					run: `echo ${defaultKey}`,
				},
			],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.notThrows(
			() => validateConfig(raw),
			`"${defaultKey}" should be overridable`,
		);
	}
});

test('validateConfig accepts disabled keybinding for a default key', t => {
	for (const defaultKey of DEFAULT_KEYBINDING_KEYS) {
		const raw = {
			version: 1,
			profiles: {
				test: {display_name: 'Test'},
			},
			keybindings: [{key: defaultKey, disabled: true}],
		};
		t.notThrows(
			() => validateConfig(raw),
			`"${defaultKey}" should be disableable`,
		);
	}
});

test('RESERVED_KEYS is the union of NON_OVERRIDABLE_KEYS and DEFAULT_KEYBINDING_KEYS', t => {
	const union = new Set([...NON_OVERRIDABLE_KEYS, ...DEFAULT_KEYBINDING_KEYS]);
	t.deepEqual(RESERVED_KEYS, union);
	// No overlap between the two sets
	for (const key of NON_OVERRIDABLE_KEYS) {
		t.false(
			DEFAULT_KEYBINDING_KEYS.has(key),
			`"${key}" should not be in both sets`,
		);
	}
});

test('validateConfig rejects duplicate keybinding keys', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{key: 'b', name: 'Build', run: 'make build'},
			{key: 'b', name: 'Build again', run: 'make build2'},
		],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('already bound'));
});

test('validateConfig rejects keybinding missing name', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [{key: 'b', run: 'make build'}],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('name: required string field'));
});

test('validateConfig rejects keybinding with neither run nor send_to_claude', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [{key: 'b', name: 'Build'}],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes("must have either 'run' or 'send_to_claude'"),
	);
});

test('validateConfig accepts send_to_claude keybinding without run', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{
				key: 'a',
				name: 'Address PR feedback',
				send_to_claude: '/address-pr-feedback',
			},
		],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('getKeybindings returns send_to_claude keybindings', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.keybindings = [
		{key: 'b', name: 'Build', run: 'make build'},
		{
			key: 'a',
			name: 'Address PR feedback',
			send_to_claude: '/address-pr-feedback',
		},
	];
	const bindings = getKeybindings(config);
	t.is(bindings.length, 2);
	t.is(bindings[1]!.key, 'a');
	t.is(bindings[1]!.send_to_claude, '/address-pr-feedback');
	t.is(bindings[1]!.run, undefined);
});

test('validateConfig accepts uppercase versions of non-overridable keys', t => {
	// Uppercase letters like 'J', 'K', 'N' should be valid even though
	// their lowercase counterparts are non-overridable built-in shortcuts
	const uppercaseReserved = [...NON_OVERRIDABLE_KEYS]
		.filter(k => k !== '?') // '?' has no uppercase
		.map(k => k.toUpperCase());

	for (const key of uppercaseReserved) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key, name: `Command ${key}`, run: `echo ${key}`}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.notThrows(() => validateConfig(raw), `"${key}" should be allowed`);
	}
});

test('validateConfig accepts uppercase versions of default keybinding keys', t => {
	// Uppercase of overridable keys (G, I, D, O, E, P) should be valid custom bindings
	const uppercaseDefaultKeys = [...DEFAULT_KEYBINDING_KEYS].map(k =>
		k.toUpperCase(),
	);

	for (const key of uppercaseDefaultKeys) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key, name: `Command ${key}`, run: `echo ${key}`}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.notThrows(() => validateConfig(raw), `"${key}" should be allowed`);
	}
});

test('validateConfig rejects disabled keybinding for a non-overridable key', t => {
	// disabled: true should not bypass the non-overridable key restriction
	for (const key of NON_OVERRIDABLE_KEYS) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key, disabled: true}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.throws(
			() => validateConfig(raw),
			undefined,
			`"${key}" should not be disableable`,
		);
	}
});

test('validateConfig rejects non-array keybindings', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: 'not an array',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('keybindings: must be an array'));
});

// ============================================================================
// Optional default_profile Tests
// ============================================================================

test('validateConfig accepts config without default_profile (uses first profile)', t => {
	const raw = {
		version: 1,
		profiles: {
			'my-app': {
				display_name: 'My App',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
	// After validation, default_profile should be set to first profile key
	t.is((raw as Record<string, unknown>)['default_profile'], 'my-app');
});

test('validateConfig rejects empty string default_profile', t => {
	const raw = {
		version: 1,
		default_profile: '',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('default_profile'));
});

test('getDefaultProfile falls back to first profile when default_profile is undefined', t => {
	const config = createConfig(
		{'first-profile': createProfile(['test'], 'First')},
		undefined,
	);
	const result = getDefaultProfile(config);
	t.is(result.name, 'first-profile');
	t.is(result.profile.display_name, 'First');
});

// ============================================================================
// Optional keywords Tests
// ============================================================================

test('validateConfig accepts profile without keywords', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-array keywords', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: 'not-an-array',
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('keywords: must be an array'));
});

test('profile without keywords never matches in matchProfiles', t => {
	const config = createConfig(
		{
			'no-kw': {display_name: 'No Keywords'},
			'has-kw': createProfile(['foo'], 'Has Keywords'),
		},
		'no-kw',
	);
	const matches = matchProfiles(config, 'foo bar');
	t.is(matches.length, 1);
	t.is(matches[0]!.name, 'has-kw');
});

test('minimal config with just team_prefix and one profile validates', t => {
	const raw = {
		version: 1,
		team_prefix: 'PROJ',
		profiles: {
			'my-app': {
				display_name: 'My App',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// mergeKeybindings Tests
// ============================================================================

test('mergeKeybindings returns base keybindings when local is empty', t => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
		{key: 't', name: 'Test', run: 'make test'},
	];
	const result = mergeKeybindings(base, []);
	t.deepEqual(result, base);
});

test('mergeKeybindings adds new keybindings from local', t => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
	];
	const local: KeybindingConfig[] = [
		{key: 'v', name: 'Open in VS Code', run: 'code .'},
	];
	const result = mergeKeybindings(base, local);
	t.is(result.length, 2);
	t.is(result[0]!.key, 'b');
	t.is(result[1]!.key, 'v');
	t.is(result[1]!.name, 'Open in VS Code');
});

test('mergeKeybindings overrides existing key with local version', t => {
	const base: KeybindingConfig[] = [
		{key: 'x', name: 'Open in Cursor', run: 'cursor .'},
		{key: 'b', name: 'Build', run: 'make build'},
	];
	const local: KeybindingConfig[] = [
		{key: 'x', name: 'Open in Nova', run: 'nova .'},
	];
	const result = mergeKeybindings(base, local);
	t.is(result.length, 2);
	const xBinding = result.find(kb => kb.key === 'x')!;
	t.is(xBinding.name, 'Open in Nova');
	t.is(xBinding.run, 'nova .');
});

test('mergeKeybindings removes disabled keybindings', t => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
		{key: 'r', name: 'Run', run: 'make run'},
		{key: 't', name: 'Test', run: 'make test'},
	];
	const local: KeybindingConfig[] = [{key: 'r', name: '', disabled: true}];
	const result = mergeKeybindings(base, local);
	t.is(result.length, 2);
	t.is(result[0]!.key, 'b');
	t.is(result[1]!.key, 't');
});

test('mergeKeybindings handles add, override, and disable together', t => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
		{key: 'r', name: 'Run', run: 'make run'},
		{key: 'x', name: 'Open Cursor', run: 'cursor .'},
	];
	const local: KeybindingConfig[] = [
		{key: 'v', name: 'VS Code', run: 'code .'},
		{key: 'x', name: 'Open Nova', run: 'nova .'},
		{key: 'r', name: '', disabled: true},
	];
	const result = mergeKeybindings(base, local);
	t.is(result.length, 3);
	const keys = result.map(kb => kb.key);
	t.deepEqual(keys, ['b', 'x', 'v']);
	t.is(result.find(kb => kb.key === 'x')!.name, 'Open Nova');
});

test('mergeKeybindings returns empty array when both are empty', t => {
	const result = mergeKeybindings([], []);
	t.deepEqual(result, []);
});

test('mergeKeybindings with only local keybindings (empty base)', t => {
	const local: KeybindingConfig[] = [
		{key: 'v', name: 'VS Code', run: 'code .'},
	];
	const result = mergeKeybindings([], local);
	t.is(result.length, 1);
	t.is(result[0]!.key, 'v');
});

test('mergeKeybindings: disabling a non-existent key is a no-op', t => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
	];
	const local: KeybindingConfig[] = [{key: 'z', name: '', disabled: true}];
	const result = mergeKeybindings(base, local);
	t.deepEqual(result, base);
});

// ============================================================================
// Validation: disabled keybindings
// ============================================================================

test('validation accepts disabled keybinding without name/run/send_to_claude', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'r', disabled: true}],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validation still rejects disabled keybinding with reserved key', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'j', disabled: true}],
	};
	const err = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(err!.errors.some(e => e.includes('"j" conflicts with built-in')));
});

test('validation still rejects disabled keybinding with invalid key', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'ab', disabled: true}],
	};
	const err = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(err!.errors.some(e => e.includes('must be a single character')));
});

// ============================================================================
// Per-profile claude and post_worktree_init validation
// ============================================================================

test('validateConfig accepts profile with valid claude.initialization_command', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: {initialization_command: '/do'},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile with non-string claude.initialization_command', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: {initialization_command: 42},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('claude.initialization_command: must be a string'),
		),
	);
});

test('validateConfig rejects profile with non-object claude section', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: 'not-an-object',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(error!.errors.some(e => e.includes('claude: must be an object')));
});

test('validateConfig accepts profile with valid post_worktree_init array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: [
					{name: 'Copy files', run: 'cp a b'},
					{run: 'echo done'},
				],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile with non-array post_worktree_init', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: 'not-an-array',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e => e.includes('post_worktree_init: must be an array')),
	);
});

test('validateConfig rejects profile post_worktree_init entry missing run', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: [{name: 'Missing run field'}],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('post_worktree_init[0].run: required string field'),
		),
	);
});

// ============================================================================
// post_workspace_init (rename of post_worktree_init) and backwards compat
// ============================================================================

test('validateConfig accepts global post_workspace_init as replacement for post_worktree_init', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			// eslint-disable-next-line no-template-curly-in-string
			{name: 'Copy env', run: 'cp .env ${WORKTREE_PATH}/.env'},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts post_worktree_init for backwards compat (global)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_worktree_init: [{name: 'Copy env', run: 'cp .env .env.bak'}],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects both post_workspace_init and post_worktree_init at global level', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [{name: 'A', run: 'echo a'}],
		post_worktree_init: [{name: 'B', run: 'echo b'}],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes(
				'post_workspace_init and post_worktree_init cannot both be specified',
			),
		),
	);
});

test('validateConfig accepts profile-level post_workspace_init', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_workspace_init: [{name: 'Setup', run: 'echo setup'}],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects both post_workspace_init and post_worktree_init at profile level', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_workspace_init: [{name: 'A', run: 'echo a'}],
				post_worktree_init: [{name: 'B', run: 'echo b'}],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes(
				'post_workspace_init and post_worktree_init cannot both be specified',
			),
		),
	);
});

// ============================================================================
// pre_workspace_deinit validation
// ============================================================================

test('validateConfig accepts global pre_workspace_deinit array', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{
				name: 'Close issue',
				// eslint-disable-next-line no-template-curly-in-string
				run: 'linctl issue update ${ISSUE_KEY} --state Done',
			},
			{run: 'echo cleanup'},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects global non-array pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: 'not-an-array',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit: must be an array'),
		),
	);
});

test('validateConfig rejects global pre_workspace_deinit entry missing run', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [{name: 'No run'}],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit[0].run: required string field'),
		),
	);
});

test('validateConfig accepts profile-level pre_workspace_deinit array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: [{name: 'Cleanup', run: 'rm -rf tmp/'}],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile non-array pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: 42,
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit: must be an array'),
		),
	);
});

test('validateConfig rejects profile pre_workspace_deinit entry missing run', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: [{name: 'Missing run'}],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit[0].run: required string field'),
		),
	);
});

// ============================================================================
// continue_on_error validation
// ============================================================================

test('validateConfig accepts continue_on_error in post_workspace_init', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			{name: 'Install', run: 'npm install', continue_on_error: true},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts continue_on_error in pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm -rf tmp/', continue_on_error: true},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts continue_on_error: false in pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm -rf tmp/', continue_on_error: false},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-boolean continue_on_error in global post_workspace_init', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			{name: 'Install', run: 'npm install', continue_on_error: 'yes'},
		],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('post_workspace_init[0].continue_on_error: must be a boolean'),
		),
	);
});

test('validateConfig rejects non-boolean continue_on_error in global pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm tmp/', continue_on_error: 1},
		],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes(
				'pre_workspace_deinit[0].continue_on_error: must be a boolean',
			),
		),
	);
});

test('validateConfig rejects non-boolean continue_on_error in profile commands', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				commands: [
					{name: 'Build', run: 'make build', continue_on_error: 'always'},
				],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('commands[0].continue_on_error: must be a boolean'),
		),
	);
});

test('validation detects duplicate keys even if one is disabled', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [
			{key: 'b', name: 'Build', run: 'make build'},
			{key: 'b', disabled: true},
		],
	};
	const err = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(err!.errors.some(e => e.includes('"b" is already bound')));
});

// ============================================================================
// issue_watchlist Validation Tests
// ============================================================================

test('validateConfig accepts valid issue_watchlist with assignee and statuses', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do', 'In Progress'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist with explicit assignee', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'charlie@example.com',
			statuses: ['In Review'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist that is not an object', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: 'not-an-object',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('issue_watchlist: must be an object'));
});

test('validateConfig accepts issue_watchlist without assignee (optional)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			statuses: ['To Do'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist with non-string assignee', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 42,
			statuses: ['To Do'],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.assignee: must be a string'),
	);
});

test('validateConfig rejects issue_watchlist without statuses', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects issue_watchlist with non-array statuses', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: 'To Do',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects issue_watchlist with empty statuses array', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: [],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects issue_watchlist with non-string statuses entries', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do', 123],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.statuses[1]: must be a string'),
	);
});

test('validateConfig accepts config without issue_watchlist', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// getIssueWatchlist Tests
// ============================================================================

test('getIssueWatchlist returns undefined when not configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.is(getIssueWatchlist(config), undefined);
});

test('getIssueWatchlist returns the configured watchlist', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.issue_watchlist = {
		assignee: 'me',
		statuses: ['To Do', 'In Progress'],
	};
	const watchlist = getIssueWatchlist(config);
	t.truthy(watchlist);
	t.is(watchlist!.assignee, 'me');
	t.deepEqual(watchlist!.statuses, ['To Do', 'In Progress']);
});

test('getIssueWatchlist returns labels when configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.issue_watchlist = {
		assignee: 'me',
		statuses: ['To Do'],
		labels: ['pappardelle', 'platform'],
	};
	const watchlist = getIssueWatchlist(config);
	t.deepEqual(watchlist!.labels, ['pappardelle', 'platform']);
});

// ============================================================================
// getResolvedWatchlists Tests (per-profile issue_watchlist)
// ============================================================================

test('getResolvedWatchlists returns [] when nothing is configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.deepEqual(getResolvedWatchlists(config), []);
});

test('getResolvedWatchlists returns only the top-level watchlist when no profile defines one (off-by-default regression)', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	t.deepEqual(getResolvedWatchlists(config), [
		{profileName: null, watchlist: {assignee: 'me', statuses: ['To Do']}},
	]);
});

test('getResolvedWatchlists never auto-scopes the top-level watchlist even when team_prefix is set', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
		'STA',
	);
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	const resolved = getResolvedWatchlists(config);
	t.is(resolved.length, 1);
	t.is(resolved[0]!.profileName, null);
	t.is(resolved[0]!.watchlist.key_prefixes, undefined);
});

test('getResolvedWatchlists includes profile watchlists additively after the top-level one', t => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
	};
	const config = createConfig({chaz}, 'chaz');
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	const resolved = getResolvedWatchlists(config);
	t.is(resolved.length, 2);
	t.is(resolved[0]!.profileName, null);
	t.is(resolved[1]!.profileName, 'chaz');
});

test('getResolvedWatchlists includes every profile that defines a watchlist', t => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'CHAZ',
		team_prefix: 'CHAZ',
		issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
	};
	const jams: Profile = {
		keywords: ['jams'],
		display_name: 'Jams',
		team_prefix: 'STA',
		issue_watchlist: {assignee: 'me', statuses: ['Ready for Pappardelle']},
	};
	// A third profile with NO watchlist must not appear in the result.
	const idle = createProfile(['idle'], 'Idle');
	const config = createConfig({chaz, jams, idle}, 'chaz');
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	const resolved = getResolvedWatchlists(config);
	t.is(resolved.length, 3);
	t.deepEqual(
		new Set(resolved.map(r => r.profileName)),
		new Set([null, 'chaz', 'jams']),
	);
});

test('getResolvedWatchlists orders the top-level watchlist first, then profiles in definition order', t => {
	// The poller dedups by "first match wins", so this ordering is the contract
	// that decides which watchlist claims an issue on overlap. Pin it so a future
	// refactor cannot silently invert the priority.
	const bravo: Profile = {
		keywords: ['bravo'],
		display_name: 'Bravo',
		team_prefix: 'BRA',
		issue_watchlist: {assignee: 'me', statuses: ['X']},
	};
	const alpha: Profile = {
		keywords: ['alpha'],
		display_name: 'Alpha',
		team_prefix: 'ALP',
		issue_watchlist: {assignee: 'me', statuses: ['Y']},
	};
	const config = createConfig({bravo, alpha}, 'bravo');
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	const resolved = getResolvedWatchlists(config);
	t.deepEqual(
		resolved.map(r => r.profileName),
		[null, 'bravo', 'alpha'],
	);
});

test('getResolvedWatchlists auto-scopes a profile watchlist to the profile team_prefix', t => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
	};
	const config = createConfig({chaz}, 'chaz');
	const resolved = getResolvedWatchlists(config);
	t.is(resolved.length, 1);
	t.deepEqual(resolved[0]!.watchlist.key_prefixes, ['CHAZ']);
	// The source config object must not be mutated by resolution.
	t.is(chaz.issue_watchlist!.key_prefixes, undefined);
});

test('getResolvedWatchlists auto-scopes a profile watchlist to the global team_prefix when the profile has none', t => {
	const foo: Profile = {
		keywords: ['foo'],
		display_name: 'Foo',
		issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
	};
	const config = createConfig({foo}, 'foo', 'STA');
	const resolved = getResolvedWatchlists(config);
	t.deepEqual(resolved[0]!.watchlist.key_prefixes, ['STA']);
});

test('getResolvedWatchlists leaves an explicit profile key_prefixes untouched (explicit wins over auto-scope)', t => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {
			assignee: 'me',
			statuses: ['For Pappardelle'],
			key_prefixes: ['WAB'],
		},
	};
	const config = createConfig({chaz}, 'chaz');
	const resolved = getResolvedWatchlists(config);
	t.deepEqual(resolved[0]!.watchlist.key_prefixes, ['WAB']);
});

test('getResolvedWatchlists treats an empty profile key_prefixes as omitted and auto-scopes', t => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {assignee: 'me', statuses: ['X'], key_prefixes: []},
	};
	const config = createConfig({chaz}, 'chaz');
	const resolved = getResolvedWatchlists(config);
	t.deepEqual(resolved[0]!.watchlist.key_prefixes, ['CHAZ']);
});

test('getResolvedWatchlists leaves a profile watchlist unscoped when no team_prefix is configured anywhere', t => {
	const foo: Profile = {
		keywords: ['foo'],
		display_name: 'Foo',
		issue_watchlist: {assignee: 'me', statuses: ['X']},
	};
	const config = createConfig({foo}, 'foo');
	const resolved = getResolvedWatchlists(config);
	// No explicit prefixes and nothing to derive from → unscoped (matches all).
	t.is(resolved[0]!.watchlist.key_prefixes, undefined);
});

// ============================================================================
// Per-profile issue_watchlist Validation Tests
// ============================================================================

test('validateConfig accepts a profile-level issue_watchlist', t => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'Charlie Personal',
				team_prefix: 'CHAZ',
				issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects a profile issue_watchlist that is not an object', t => {
	const raw = {
		version: 1,
		profiles: {chaz: {display_name: 'X', issue_watchlist: 'nope'}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('profiles.chaz.issue_watchlist: must be an object'),
	);
});

test('validateConfig rejects a profile issue_watchlist without statuses', t => {
	const raw = {
		version: 1,
		profiles: {chaz: {display_name: 'X', issue_watchlist: {assignee: 'me'}}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects a profile issue_watchlist with non-string assignee', t => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'X',
				issue_watchlist: {assignee: 5, statuses: ['To Do']},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.assignee: must be a string',
		),
	);
});

test('validateConfig rejects a profile issue_watchlist with an empty key_prefix', t => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'X',
				issue_watchlist: {statuses: ['To Do'], key_prefixes: ['STA', '']},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.key_prefixes[1]: must not be empty',
		),
	);
});

// ============================================================================
// issue_watchlist labels Validation Tests
// ============================================================================

test('validateConfig accepts issue_watchlist with labels', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: ['pappardelle', 'platform'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist without labels (optional)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist with non-array labels', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: 'not-an-array',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('issue_watchlist.labels: must be an array'));
});

test('validateConfig rejects issue_watchlist with non-string label entries', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: ['valid', 123],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.labels[1]: must be a string'),
	);
});

test('validateConfig accepts issue_watchlist with empty labels array', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: [],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// issue_watchlist key_prefixes Validation Tests
// ============================================================================

test('validateConfig accepts issue_watchlist with key_prefixes', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', 'ENG'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist without key_prefixes (optional)', t => {
	// Off-by-default regression: the field is optional and absence is valid.
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist with empty key_prefixes array', t => {
	// Empty array means "watch every prefix" — same as omitting the field.
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: [],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist with non-array key_prefixes', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: 'not-an-array',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.key_prefixes: must be an array'),
	);
});

test('validateConfig rejects issue_watchlist with non-string key_prefix entries', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', 123],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.key_prefixes[1]: must be a string',
		),
	);
});

test('validateConfig rejects issue_watchlist with empty-string key_prefix', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', ''],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.key_prefixes[1]: must not be empty',
		),
	);
});

test('validateConfig rejects issue_watchlist with whitespace-only key_prefix', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['   '],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.key_prefixes[0]: must not be empty',
		),
	);
});

test('getIssueWatchlist returns key_prefixes when configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.issue_watchlist = {
		assignee: 'me',
		statuses: ['To Do'],
		key_prefixes: ['STA'],
	};
	const watchlist = getIssueWatchlist(config);
	t.deepEqual(watchlist!.key_prefixes, ['STA']);
});

// ============================================================================
// auto_remove_when_done Validation Tests
// ============================================================================

test('validateConfig accepts auto_remove_when_done set to true', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: true,
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts auto_remove_when_done set to false', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: false,
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts config without auto_remove_when_done (off by default)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects auto_remove_when_done with a non-boolean value', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: 'yes',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('auto_remove_when_done: must be a boolean'));
});

test('validateConfig rejects auto_remove_when_done with a numeric value', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: 1,
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('auto_remove_when_done: must be a boolean'));
});

// ============================================================================
// getAutoRemoveWhenDone Tests
// ============================================================================

test('getAutoRemoveWhenDone defaults to false when not configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.false(getAutoRemoveWhenDone(config));
});

test('getAutoRemoveWhenDone returns true when configured true', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.auto_remove_when_done = true;
	t.true(getAutoRemoveWhenDone(config));
});

test('getAutoRemoveWhenDone returns false when configured false', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.auto_remove_when_done = false;
	t.false(getAutoRemoveWhenDone(config));
});

// ============================================================================
// companion_command Validation Tests
// ============================================================================

test('validateConfig accepts top-level companion_command string', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: 'gitui',
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts an empty-string companion_command (plain shell)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: '',
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts config without companion_command (default applies)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-string companion_command', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: 42,
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('companion_command: must be a string'));
});

test('validateConfig accepts a per-profile companion_command string', t => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', companion_command: 'make run'},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects a non-string per-profile companion_command', t => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', companion_command: ['make', 'run']},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.backend.companion_command: must be a string',
		),
	);
});

// ============================================================================
// getCompanionCommand Tests
// ============================================================================

test('getCompanionCommand defaults to gitui when nothing is configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.is(getCompanionCommand(config), DEFAULT_COMPANION_COMMAND);
	t.true(getCompanionCommand(config).includes('gitui'));
});

test('getCompanionCommand returns the top-level command when set', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.companion_command = 'lazygit';
	t.is(getCompanionCommand(config), 'lazygit');
});

test('getCompanionCommand preserves an explicit empty top-level command', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.companion_command = '';
	t.is(getCompanionCommand(config), '');
});

test('getCompanionCommand prefers a matched profile override over top-level', t => {
	const config = createConfig(
		{
			backend: {
				...createProfile(['backend'], 'Backend'),
				companion_command: 'make run',
			},
		},
		'backend',
	);
	config.companion_command = 'gitui';
	t.is(getCompanionCommand(config, 'fix backend timeout'), 'make run');
});

test('getCompanionCommand falls back to top-level when the matched profile has no override', t => {
	const config = createConfig(
		{backend: createProfile(['backend'], 'Backend')},
		'backend',
	);
	config.companion_command = 'lazygit';
	t.is(getCompanionCommand(config, 'fix backend timeout'), 'lazygit');
});

test('getCompanionCommand falls back to default when neither profile nor top-level set', t => {
	const config = createConfig(
		{backend: createProfile(['backend'], 'Backend')},
		'backend',
	);
	t.is(
		getCompanionCommand(config, 'fix backend timeout'),
		DEFAULT_COMPANION_COMMAND,
	);
});

test('getCompanionCommand uses top-level when the title matches no profile', t => {
	const config = createConfig(
		{
			backend: {
				...createProfile(['backend'], 'Backend'),
				companion_command: 'make run',
			},
		},
		'backend',
	);
	config.companion_command = 'gitui';
	// "unrelated" matches no keyword, so the backend override must NOT apply.
	t.is(getCompanionCommand(config, 'unrelated task'), 'gitui');
});

// ============================================================================
// tracker_projects Validation Tests
// ============================================================================

test('validateConfig accepts profile with valid tracker_projects array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: ['The Hive', 'The Hive Quality'],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts profile without tracker_projects (optional)', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile with non-array tracker_projects', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: 'The Hive',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('tracker_projects: must be an array when specified'),
		),
	);
});

test('validateConfig rejects profile with non-string tracker_projects entries', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: ['The Hive', 42],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('tracker_projects[1]: must be a string'),
		),
	);
});

test('validateConfig accepts profile with empty tracker_projects array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: [],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// matchProfileByProject Tests
// ============================================================================

test('matchProfileByProject matches exact project name', t => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive', 'The Hive Quality'],
		},
		jams: {
			display_name: 'Stardust Jams',
			keywords: ['music'],
			tracker_projects: ['Stardust Jams'],
		},
	});
	const match = matchProfileByProject(config, 'The Hive');
	t.truthy(match);
	t.is(match!.name, 'hive');
	t.is(match!.profile.display_name, 'King Bee');
});

test('matchProfileByProject is case-insensitive', t => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
		},
	});
	const match = matchProfileByProject(config, 'the hive');
	t.truthy(match);
	t.is(match!.name, 'hive');
});

test('matchProfileByProject returns null when no match', t => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
		},
	});
	const match = matchProfileByProject(config, 'Unknown Project');
	t.is(match, null);
});

test('matchProfileByProject returns null for empty project name', t => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
		},
	});
	t.is(matchProfileByProject(config, ''), null);
});

// STA-1649: Jira issues carry a project key ("KAN") alongside the display
// name ("Pappardelle Testing"); tracker_projects entries may be either.

test('matchProfileByProject matches the Jira project key via the optional projectKey arg', t => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	const match = matchProfileByProject(config, 'Pappardelle Testing', 'KAN');
	t.truthy(match);
	t.is(match!.name, 'testing');
});

test('matchProfileByProject key matching is case-insensitive', t => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['kan'],
		},
	});
	const match = matchProfileByProject(config, 'Pappardelle Testing', 'KAN');
	t.truthy(match);
	t.is(match!.name, 'testing');
});

test('matchProfileByProject matches by key even when the project name is empty', t => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	const match = matchProfileByProject(config, '', 'KAN');
	t.truthy(match);
	t.is(match!.name, 'testing');
});

test('matchProfileByProject without a projectKey never matches key-style entries (regression pin)', t => {
	// A config listing only the Jira key must not match when callers pass just
	// a name — the Linear path (name-only) behaves exactly as before STA-1649.
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	t.is(matchProfileByProject(config, 'Pappardelle Testing'), null);
});

test('matchProfileByProject returns null when neither name nor key matches', t => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['Some Other Project'],
		},
	});
	t.is(matchProfileByProject(config, 'Pappardelle Testing', 'KAN'), null);
});

test('matchProfileByProject returns null when both name and key are empty', t => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	t.is(matchProfileByProject(config, '', ''), null);
	t.is(matchProfileByProject(config, ''), null);
});

test('matchProfileByProject returns null when no profiles have tracker_projects', t => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
		},
	});
	const match = matchProfileByProject(config, 'The Hive');
	t.is(match, null);
});

test('matchProfileByProject matches second tracker_projects entry', t => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive', 'The Hive Quality'],
		},
	});
	const match = matchProfileByProject(config, 'The Hive Quality');
	t.truthy(match);
	t.is(match!.name, 'hive');
});

test('matchProfileByProject returns first matching profile when multiple match', t => {
	const config = createConfig({
		first: {
			display_name: 'First',
			keywords: ['a'],
			tracker_projects: ['Shared Project'],
		},
		second: {
			display_name: 'Second',
			keywords: ['b'],
			tracker_projects: ['Shared Project'],
		},
	});
	const match = matchProfileByProject(config, 'Shared Project');
	t.truthy(match);
	t.is(match!.name, 'first');
});

test('matchProfileByProject handles mixed case project name in config', t => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['THE HIVE QUALITY'],
		},
	});
	const match = matchProfileByProject(config, 'The Hive Quality');
	t.truthy(match);
	t.is(match!.name, 'hive');
});

// ============================================================================
// getProfileDefaultProject (STA-959)
//
// When idow creates a new issue under a profile, the profile's
// `tracker_projects[0]` is treated as the default project for that issue —
// resolved to a Linear project UUID by provider-helpers.sh::create_issue.
// This helper centralizes the "first entry, or undefined" semantics so the
// TS side and the bash side stay in sync.
//
// Off-by-default regression: profiles without `tracker_projects` (or with an
// empty array) must return undefined so create_issue falls back to the
// pre-STA-959 behavior of creating an unassigned issue.
// ============================================================================

test('getProfileDefaultProject returns first tracker_projects entry', t => {
	const profile: Profile = {
		display_name: 'King Bee',
		keywords: ['bee'],
		tracker_projects: ['The Hive Quality', 'Wordle'],
	};
	t.is(getProfileDefaultProject(profile), 'The Hive Quality');
});

test('getProfileDefaultProject returns sole tracker_projects entry', t => {
	const profile: Profile = {
		display_name: 'Pappardelle',
		keywords: ['pappardelle'],
		tracker_projects: ['Pappardelle Quality'],
	};
	t.is(getProfileDefaultProject(profile), 'Pappardelle Quality');
});

test('getProfileDefaultProject returns undefined when tracker_projects omitted (off-by-default)', t => {
	const profile: Profile = {
		display_name: 'Personal',
		keywords: ['personal'],
	};
	t.is(getProfileDefaultProject(profile), undefined);
});

test('getProfileDefaultProject returns undefined for empty tracker_projects (off-by-default)', t => {
	const profile: Profile = {
		display_name: 'Test',
		keywords: ['t'],
		tracker_projects: [],
	};
	t.is(getProfileDefaultProject(profile), undefined);
});

test("getProfileDefaultProject preserves exact casing — UUID resolution is the bash side's responsibility", t => {
	const profile: Profile = {
		display_name: 'Mixed',
		keywords: ['m'],
		tracker_projects: ['  Stardust Jams MVP  '],
	};
	// Whatever the user wrote is what we return — provider-helpers.sh's jq filter
	// is what decides whether trimming/case-folding happens at resolution time.
	t.is(getProfileDefaultProject(profile), '  Stardust Jams MVP  ');
});

// ============================================================================
// determineProfileForInput (STA-856, STA-865)
//
// Single source of truth for "which profile will this input resolve to?",
// shared by the PromptDialog display and the idow spawn arg. Whatever the
// dialog shows MUST be the profile actually passed to idow.
//
// STA-865: for issue-key / bare-number / Linear-URL inputs we can't pick a
// profile yet — the right profile is whatever matches the fetched issue's
// Linear project via `tracker_projects`. Return `{kind: 'deferred'}` so the
// TUI shows "Determined by issue project" and forwards `null` to idow, which
// lets idow's existing project-matching block (scripts/idow ~L470) run.
// ============================================================================

test('determineProfileForInput returns null for empty / whitespace input', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	t.is(determineProfileForInput(config, ''), null);
	t.is(determineProfileForInput(config, '   \t '), null);
});

test('determineProfileForInput defers profile selection for issue keys', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'STA-123');
	t.truthy(info);
	t.is(info!.kind, 'deferred');
	if (info!.kind === 'deferred') {
		t.is(info.displayName, DEFERRED_PROFILE_DISPLAY_NAME);
	}
});

test('determineProfileForInput defers profile selection for bare issue numbers', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, '42');
	t.truthy(info);
	t.is(info!.kind, 'deferred');
	if (info!.kind === 'deferred') {
		t.is(info.displayName, DEFERRED_PROFILE_DISPLAY_NAME);
	}
});

test('determineProfileForInput defers profile selection for Linear URLs', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(
		config,
		'https://linear.app/stardust-labs/issue/STA-123/something',
	);
	t.truthy(info);
	t.is(info!.kind, 'deferred');
	if (info!.kind === 'deferred') {
		t.is(info.displayName, DEFERRED_PROFILE_DISPLAY_NAME);
	}
});

test('determineProfileForInput returns default profile when no keyword matches', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'random description nothing');
	t.truthy(info);
	t.is(info!.kind, 'resolved');
	if (info!.kind === 'resolved') {
		t.is(info.name, 'personal');
		t.true(info.isDefault);
		t.deepEqual(info.matchedKeywords, []);
	}
});

test('determineProfileForInput picks the single matching profile', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'upload to trotbooks');
	t.truthy(info);
	t.is(info!.kind, 'resolved');
	if (info!.kind === 'resolved') {
		t.is(info.name, 'trotbooks');
		t.false(info.isDefault);
	}
});

test('determineProfileForInput picks highest-scoring profile on multi-match (STA-856 regression)', t => {
	// This is the exact shape of the bug: "personal" matches 1 keyword, "trotbooks"
	// matches 2 keywords (trotbooks + trot via prefix). The TUI sorted by score and
	// displayed trotbooks, but idow's bash matcher used config iteration order and
	// picked personal. determineProfileForInput must return the same winner the
	// TUI was already showing — i.e. the highest-scoring match.
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks', 'trot', 'horse'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(
		config,
		'make it so i can upload a personal image to trotbooks',
	);
	t.truthy(info);
	t.is(info!.kind, 'resolved');
	if (info!.kind === 'resolved') {
		t.is(info.name, 'trotbooks');
		t.false(info.isDefault);
		// Should surface the keywords that tipped the scoring so the caller can show them.
		t.true(info.matchedKeywords.length >= 2);
	}
});

test('determineProfileForInput honors enforced (!) keywords', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks', 'trot'], 'TrotBooks'),
		},
		'personal',
	);
	// Enforcing "personal!" must win even though trotbooks scores higher without it.
	const info = determineProfileForInput(
		config,
		'upload a personal! image to trotbooks',
	);
	t.truthy(info);
	t.is(info!.kind, 'resolved');
	if (info!.kind === 'resolved') {
		t.is(info.name, 'personal');
		t.true(info.enforced);
	}
});
