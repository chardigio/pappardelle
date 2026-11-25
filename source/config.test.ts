import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
	getListLayout,
	getRailGroups,
	isRailGroupedByStatus,
	getPaneWidths,
	getCompanionCommand,
	getCompanionSplits,
	getIdeCommand,
	getStateColors,
	getSousChefKey,
	DEFAULT_COMPANION_COMMAND,
	DEFAULT_IDE_COMMAND,
	repoNameFromGitCommonDir,
	buildWorkspaceTemplateVars,
	parseConfigLayer,
	mergeKeybindings,
	determineProfileForInput,
	getBeadsPrefixes,
	parseBdIssuePrefix,
	exampleIssueKeys,
	readBeadsIssuePrefix,
	clearBeadsIssuePrefixCache,
	matchProfilesByKeyPrefix,
	matchProfilesByInputKeyPrefix,
	DEFERRED_PROFILE_DISPLAY_NAME,
	getAgentProfile,
	listAgentProfiles,
	checkAgentProfile,
	loadAgentProfileSources,
} from './config.ts';
import {ConfigValidationError} from './config-errors.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	CODE_IDE_COMMAND,
	validateListView,
} from '../test/helpers/config-fixtures.ts';

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
		templateVarsTestConfig,
	);
	t.is(vars.ISSUE_KEY, 'STA-999');
	t.is(vars.WORKTREE_PATH, '/tmp/worktree');
	t.truthy(vars.REPO_ROOT);
	t.truthy(vars.REPO_NAME);
	t.truthy(vars.SCRIPT_DIR);
});

test('buildWorkspaceTemplateVars prefers an explicit profileName over the title match', t => {
	// The `d` key resolves the profile from space-state, then expands that
	// profile's ide_command. If the vars came from a keyword match on the title
	// instead, the command would run with its own profile's vars unset.
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug', // matches stardust-jams
		'pappardelle', // but this is the profile the space was created with
	);
	t.is(vars['IOS_APP_DIR'], undefined);
	t.is(vars['SCHEME'], undefined);
});

test('buildWorkspaceTemplateVars uses the named profile vars even when the title matches nothing', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'unrelated title',
		'stardust-jams',
	);
	t.is(vars['IOS_APP_DIR'], '_ios/stardust-jams');
	t.is(vars['SCHEME'], 'stardust-jams');
});

test('buildWorkspaceTemplateVars falls back to the title match for an unknown profileName', t => {
	// A stale profile name persisted in space-state must not strip the vars.
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug',
		'deleted_profile',
	);
	t.is(vars['IOS_APP_DIR'], '_ios/stardust-jams');
});

test('buildWorkspaceTemplateVars merges profile vars when title matches', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug',
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
		templateVarsTestConfig,
		'fix stardust jams bug',
	);
	t.is(vars.VCS_LABEL, 'stardust_jams');
	t.is(vars.GITHUB_LABEL, 'stardust_jams');
});

test('buildWorkspaceTemplateVars falls back to default profile when no title match', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'zzz nonexistent topic',
	);
	// Default profile is "pappardelle" which has no vars, so custom vars should be absent
	t.is(vars['IOS_APP_DIR'], undefined);
	t.is(vars['BUNDLE_ID'], undefined);
});

test('buildWorkspaceTemplateVars falls back to default profile when no title provided', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
	);
	// No title = no match = falls back to default profile (pappardelle, no vars)
	t.is(vars['IOS_APP_DIR'], undefined);
});

test('buildWorkspaceTemplateVars does not overwrite base vars with profile vars', t => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug',
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

// ============================================================================
// Optional default_profile Tests
// ============================================================================

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
// issue_watchlist key_prefixes Validation Tests
// ============================================================================

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
// getCompanionCommand Tests
// ============================================================================

test('companion_splits: a matched profile replaces the top-level list, and split defaults to down', t => {
	const config = createConfig(
		{
			backend: {
				...createProfile(['backend'], 'Backend'),
				companion_splits: [{name: 'api', command: 'make run', size: 40}],
			},
			web: createProfile(['web'], 'Web'),
		},
		'web',
	);
	config.companion_splits = [
		{name: 'tests', command: 'bun test --watch', split: 'right', size: '30%'},
	];
	t.deepEqual(getCompanionSplits(config, 'fix backend timeout'), [
		{name: 'api', command: 'make run', size: 40, split: 'down'},
	]);
	t.deepEqual(getCompanionSplits(config, 'web tweak'), [
		{name: 'tests', command: 'bun test --watch', split: 'right', size: '30%'},
	]);
	t.deepEqual(getCompanionSplits(createConfig({}, undefined)), []);
});

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
// ide_command Validation Tests
// ============================================================================

// eslint-disable-next-line no-template-curly-in-string -- a shell template, expanded by bash, not JS
const IDEA_IDE_COMMAND = 'idea "${WORKTREE_PATH}"';

// ============================================================================
// getIdeCommand Tests
// ============================================================================

test('getIdeCommand defaults to Cursor when nothing is configured', t => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	t.is(getIdeCommand(config), DEFAULT_IDE_COMMAND);
	t.true(getIdeCommand(config).includes('cursor'));
});

test('getIdeCommand returns the top-level command when set', t => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = CODE_IDE_COMMAND;
	t.is(getIdeCommand(config), CODE_IDE_COMMAND);
});

test('getIdeCommand prefers the named profile override over top-level', t => {
	const config = createConfig({
		backend: {
			...createProfile(['backend'], 'Backend'),
			ide_command: IDEA_IDE_COMMAND,
		},
	});
	config.ide_command = CODE_IDE_COMMAND;
	t.is(getIdeCommand(config, 'backend'), IDEA_IDE_COMMAND);
});

test('getIdeCommand falls back to top-level when the named profile has no override', t => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = CODE_IDE_COMMAND;
	t.is(getIdeCommand(config, 'backend'), CODE_IDE_COMMAND);
});

test('getIdeCommand falls back to top-level for a profile name not in config', t => {
	// A stale profile name persisted in space-state must not crash or resolve to
	// some other profile's editor.
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = CODE_IDE_COMMAND;
	t.is(getIdeCommand(config, 'deleted_profile'), CODE_IDE_COMMAND);
});

test('getIdeCommand preserves an explicit empty top-level command', t => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = '';
	t.is(getIdeCommand(config), '');
});

test('getIdeCommand preserves an explicit empty profile command over a set top-level', t => {
	const config = createConfig({
		backend: {...createProfile(['backend'], 'Backend'), ide_command: ''},
	});
	config.ide_command = CODE_IDE_COMMAND;
	t.is(getIdeCommand(config, 'backend'), '');
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
// matchProfilesByKeyPrefix
//
// Which profiles could plausibly own an issue whose key carries a given
// prefix. Explicit claims (own team_prefix, or a tracker_projects entry
// spelling a Jira project key) outrank the profiles that merely inherit the
// global team_prefix.
// ============================================================================

test('matchProfilesByKeyPrefix matches a profile own team_prefix', t => {
	const config = createConfig(
		{
			personal: {
				...createProfile(['personal'], 'Personal'),
				team_prefix: 'PER',
			},
			trotbooks: {
				...createProfile(['trotbooks'], 'TrotBooks'),
				team_prefix: 'TRT',
			},
		},
		'personal',
		'STA',
	);
	t.deepEqual(
		matchProfilesByKeyPrefix(config, 'TRT').map(m => m.name),
		['trotbooks'],
	);
});

test('matchProfilesByKeyPrefix matches case-insensitively', t => {
	const config = createConfig(
		{
			personal: {
				...createProfile(['personal'], 'Personal'),
				team_prefix: 'per',
			},
		},
		'personal',
		'STA',
	);
	t.deepEqual(
		matchProfilesByKeyPrefix(config, 'per').map(m => m.name),
		['personal'],
	);
});

test('matchProfilesByKeyPrefix matches a tracker_projects entry as a project key', t => {
	const config = createConfig(
		{
			personal: {
				...createProfile(['personal'], 'Personal'),
				tracker_projects: ['KAN'],
			},
			trotbooks: {
				...createProfile(['trotbooks'], 'TrotBooks'),
				team_prefix: 'TRT',
			},
		},
		'personal',
		'STA',
	);
	const matches = matchProfilesByKeyPrefix(config, 'KAN');
	t.deepEqual(
		matches.map(m => m.name),
		['personal'],
	);
	t.true(matches[0]!.explicit);
});

test('matchProfilesByKeyPrefix matches an issue_watchlist key_prefixes entry', t => {
	// The watchlist already spawns these issues under this profile
	// (idow --profile), so a hand-typed key of the same prefix has to be able to
	// reach it too.
	const config = createConfig(
		{
			personal: {
				...createProfile(['personal'], 'Personal'),
				issue_watchlist: {
					assignee: 'me',
					statuses: ['To Do'],
					key_prefixes: ['SDJ'],
				},
			},
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'trotbooks',
		'STA',
	);
	const matches = matchProfilesByKeyPrefix(config, 'SDJ');
	t.deepEqual(
		matches.map(m => m.name),
		['personal'],
	);
	t.true(matches[0]!.explicit);
});

test('matchProfilesByKeyPrefix treats prefix-less profiles as inheriting the global prefix', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: {
				...createProfile(['trotbooks'], 'TrotBooks'),
				team_prefix: 'TRT',
			},
		},
		'personal',
		'STA',
	);
	const matches = matchProfilesByKeyPrefix(config, 'STA');
	t.deepEqual(
		matches.map(m => m.name),
		['personal'],
	);
	t.false(matches[0]!.explicit);
});

test('matchProfilesByKeyPrefix ranks explicit claims ahead of inherited ones', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: {
				...createProfile(['trotbooks'], 'TrotBooks'),
				team_prefix: 'STA',
			},
		},
		'personal',
		'STA',
	);
	t.deepEqual(
		matchProfilesByKeyPrefix(config, 'STA').map(m => m.name),
		['trotbooks', 'personal'],
	);
});

test('matchProfilesByKeyPrefix returns nothing for an unclaimed prefix', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
		'STA',
	);
	t.deepEqual(matchProfilesByKeyPrefix(config, 'ZZZ'), []);
	t.deepEqual(matchProfilesByKeyPrefix(config, '  '), []);
});

test('matchProfilesByKeyPrefix falls back to the STA default when no team_prefix is set', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	t.deepEqual(
		matchProfilesByKeyPrefix(config, 'STA').map(m => m.name),
		['personal'],
	);
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

test('determineProfileForInput defers profile selection for beads IDs', t => {
	// Beads IDs match none of the classic patterns, so without this they would
	// keyword-match and get pinned via --profile before the issue is fetched —
	// defeating the prefix-based tracker_projects routing idow performs.
	const config = {
		...createConfig(
			{
				personal: createProfile(['personal'], 'Personal'),
				dark: createProfile(['dark'], 'Dark Mode Work'),
			},
			'personal',
		),
		team_prefix: 'pap',
		issue_tracker: {provider: 'beads' as const},
	};
	const info = determineProfileForInput(config, 'pap-a1b2');
	t.is(info?.kind, 'deferred');
});

test('determineProfileForInput keyword-matches a beads-shaped phrase', t => {
	// 'dark-mode' is prose, not an ID — no profile lists 'dark' as a prefix.
	const config = {
		...createConfig(
			{
				personal: createProfile(['personal'], 'Personal'),
				dark: createProfile(['dark'], 'Dark Mode Work'),
			},
			'personal',
		),
		team_prefix: 'pap',
		issue_tracker: {provider: 'beads' as const},
	};
	const info = determineProfileForInput(config, 'dark-mode');
	t.is(info?.kind, 'resolved');
});

test('determineProfileForInput marks a beads ID pickable even when nothing claims its prefix', t => {
	// A beads database is not a project: one prefix backs work belonging to
	// several profiles, so the tracker-project lookup can only ever guess and
	// the caller has to offer the choice. Every profile here names a prefix of
	// its own, so nobody claims 'pap' by inheritance either.
	const config = {
		...createConfig(
			{
				personal: {
					...createProfile(['personal'], 'Personal'),
					team_prefix: 'STA',
				},
				dark: {
					...createProfile(['dark'], 'Dark Mode Work'),
					team_prefix: 'SDJ',
				},
			},
			'personal',
		),
		team_prefix: 'pap',
		issue_tracker: {provider: 'beads' as const},
	};
	t.deepEqual(matchProfilesByInputKeyPrefix(config, 'pap-a1b2'), []);
	const info = determineProfileForInput(config, 'pap-a1b2');
	t.is(info!.kind, 'deferred');
	if (info!.kind === 'deferred') t.true(info.canPick);
});

test('matchProfilesByInputKeyPrefix reads the prefix of a beads ID', t => {
	// The prefix of 'vendor-sdk-a1b2' is everything ahead of the last hyphen,
	// which is the name a profile spells in tracker_projects.
	const config = {
		...createConfig(
			{
				personal: createProfile(['personal'], 'Personal'),
				vendor: {
					...createProfile(['vendor'], 'Vendor SDK'),
					tracker_projects: ['vendor-sdk'],
				},
			},
			'personal',
		),
		team_prefix: 'STA',
		issue_tracker: {provider: 'beads' as const},
	};
	t.deepEqual(
		matchProfilesByInputKeyPrefix(config, 'vendor-sdk-a1b2').map(m => m.name),
		['vendor'],
	);
});

test('determineProfileForInput does not defer beads IDs under other trackers', t => {
	// Regression pin: the beads branch must be gated on the configured provider.
	const config = {
		...createConfig(
			{personal: createProfile(['personal'], 'Personal')},
			'personal',
		),
		team_prefix: 'pap',
	};
	t.is(determineProfileForInput(config, 'pap-a1b2')?.kind, 'resolved');
});

// ============================================================================
// exampleIssueKeys
// ============================================================================

test('exampleIssueKeys uses the team prefix for numbered trackers', t => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'qa',
		profiles: {},
	};
	t.deepEqual(exampleIssueKeys(config), ['QA-123', '123']);
});

test('exampleIssueKeys shows a beads id with the beads prefix', t => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'qa',
		issue_tracker: {provider: 'beads'},
		profiles: {},
	};
	t.deepEqual(
		exampleIssueKeys(config, () => 'pap'),
		['pap-a1b2'],
	);
});

// ============================================================================
// getBeadsPrefixes
// ============================================================================

test('getBeadsPrefixes collects the team prefix and tracker_projects', t => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'pap',
		profiles: {
			platform: {
				display_name: 'Platform',
				tracker_projects: ['myproj', 'vendor-sdk'],
			},
			other: {display_name: 'Other', team_prefix: 'alt'},
		},
	};
	t.deepEqual(getBeadsPrefixes(config).sort(), [
		'alt',
		'myproj',
		'pap',
		'vendor-sdk',
	]);
});

test('getBeadsPrefixes lowercases and dedupes', t => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'PAP',
		profiles: {a: {display_name: 'A', tracker_projects: ['pap', ' Pap ']}},
	};
	t.deepEqual(getBeadsPrefixes(config), ['pap']);
});

test('getBeadsPrefixes is empty when nothing is configured', t => {
	t.deepEqual(getBeadsPrefixes({version: 1, profiles: {}}), []);
});

test('getBeadsPrefixes includes the database issue-prefix', t => {
	// bd mints IDs under .beads/config.yaml's issue-prefix, which need not match
	// team_prefix — a repo migrating off Linear keeps the old team prefix while
	// beads names issues after the repo directory. Missing it made those IDs read
	// as prose and file a duplicate issue.
	t.deepEqual(
		getBeadsPrefixes({version: 1, profiles: {}, team_prefix: 'STA'}, 'myrepo'),
		['myrepo', 'sta'],
	);
});

test('getBeadsPrefixes lowercases and dedupes the database issue-prefix', t => {
	t.deepEqual(
		getBeadsPrefixes({version: 1, profiles: {}, team_prefix: 'pap'}, 'PAP'),
		['pap'],
	);
});

test('readBeadsIssuePrefix reads issue-prefix from .beads/config.yaml', t => {
	const dir = tempDir(t, 'beads-prefix-');
	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(
		path.join(dir, '.beads', 'config.yaml'),
		'issue-prefix: vendor-sdk\n',
	);
	t.is(readBeadsIssuePrefix(dir), 'vendor-sdk');
});

test('readBeadsIssuePrefix is undefined when the file or key is absent', t => {
	const noDatabasePrefix = () => undefined;
	const dir = tempDir(t, 'beads-prefix-');
	t.is(readBeadsIssuePrefix(dir, noDatabasePrefix), undefined);

	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(path.join(dir, '.beads', 'config.yaml'), 'other: value\n');
	clearBeadsIssuePrefixCache();
	t.is(readBeadsIssuePrefix(dir, noDatabasePrefix), undefined);
});

test('readBeadsIssuePrefix falls back to the bd database without a config.yaml prefix', t => {
	const dir = tempDir(t, 'beads-prefix-');
	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(
		path.join(dir, '.beads', 'config.yaml'),
		'# issue-prefix: ""\n',
	);
	t.is(
		readBeadsIssuePrefix(dir, root => (root === dir ? 'qa' : undefined)),
		'qa',
	);
});

test('parseBdIssuePrefix reads plain and enveloped bd config output', t => {
	t.is(parseBdIssuePrefix('{"key":"issue_prefix","value":"QA"}\n'), 'QA');
	t.is(
		parseBdIssuePrefix(
			'{"schema_version":1,"data":{"key":"issue_prefix","value":"QA"}}\n',
		),
		'QA',
	);
	t.is(parseBdIssuePrefix('{"key":"issue_prefix","value":"  "}'), undefined);
});

test('readBeadsIssuePrefix asks bd only in a beads repo', t => {
	const dir = tempDir(t, 'beads-prefix-');
	t.is(
		readBeadsIssuePrefix(dir, () => 'qa'),
		undefined,
	);
});

// determineProfileForInput runs on every keystroke in the new-session prompt,
// so this has to stay a cache hit — an uncached read puts a blocking
// readFileSync and a YAML parse on the TUI's render path per character.
test('readBeadsIssuePrefix parses .beads/config.yaml at most once per root', t => {
	const dir = tempDir(t, 'beads-prefix-');
	fs.mkdirSync(path.join(dir, '.beads'));
	const configPath = path.join(dir, '.beads', 'config.yaml');
	fs.writeFileSync(configPath, 'issue-prefix: first\n');

	clearBeadsIssuePrefixCache();
	t.is(readBeadsIssuePrefix(dir), 'first');

	// Rewriting on disk must not be observable: a second call that re-reads
	// would return 'second' and fail here.
	fs.writeFileSync(configPath, 'issue-prefix: second\n');
	t.is(readBeadsIssuePrefix(dir), 'first');

	// The cache is keyed per root, so a different repo still resolves on its own.
	const other = tempDir(t, 'beads-prefix-');
	fs.mkdirSync(path.join(other, '.beads'));
	fs.writeFileSync(
		path.join(other, '.beads', 'config.yaml'),
		'issue-prefix: elsewhere\n',
	);
	t.is(readBeadsIssuePrefix(other), 'elsewhere');
	t.is(readBeadsIssuePrefix(dir), 'first');
});

// A repo with no beads config is the case that would otherwise re-stat a
// missing file on every keystroke, so the negative result has to cache too.
test('readBeadsIssuePrefix caches a missing .beads/config.yaml', t => {
	const dir = tempDir(t, 'beads-prefix-');

	clearBeadsIssuePrefixCache();
	t.is(readBeadsIssuePrefix(dir), undefined);

	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(
		path.join(dir, '.beads', 'config.yaml'),
		'issue-prefix: x\n',
	);
	t.is(readBeadsIssuePrefix(dir), undefined);
});

test('determineProfileForInput defers a lowercase issue key like an uppercase one', t => {
	// A lowercase key reaches the tracker as the same issue, so it has to reach
	// the same profile decision — otherwise the preview and the option list the
	// picker renders disagree about what Enter is going to do.
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	t.is(determineProfileForInput(config, 'sta-123')!.kind, 'deferred');
	t.is(
		determineProfileForInput(
			config,
			'https://linear.app/acme/issue/sta-123/slug',
		)!.kind,
		'deferred',
	);
});

test('determineProfileForInput marks a claimed key prefix as pickable', t => {
	// Neither profile names a prefix, so both inherit the global one and both
	// could own STA-123 — the caller should offer the choice rather than an
	// inert label.
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'STA-123');
	t.is(info!.kind, 'deferred');
	if (info!.kind === 'deferred') t.true(info.canPick);
});

test('determineProfileForInput leaves an unclaimed key prefix unpickable', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, 'ZZZ-123');
	t.is(info!.kind, 'deferred');
	if (info!.kind === 'deferred') t.false(info.canPick);
});

test('determineProfileForInput leaves a bare number unpickable', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, '42');
	t.is(info!.kind, 'deferred');
	if (info!.kind === 'deferred') t.false(info.canPick);
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

// ============================================================================
// determineProfileForInput — profile emoji (STA-1837)
//
// The typing-stage hint in PromptDialog shows the same glyph the picker will
// show one keystroke later, so the emoji has to ride along with the selection
// rather than be re-resolved by the component.
// ============================================================================

test('determineProfileForInput carries the matched profile emoji', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: {...createProfile(['trotbooks'], 'TrotBooks'), emoji: '🐎'},
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'fix trotbooks invoices');
	t.is(info!.kind, 'resolved');
	if (info!.kind === 'resolved') {
		t.is(info.emoji, '🐎');
	}
});

test('determineProfileForInput reserves a blank emoji slot when siblings have one', t => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: {...createProfile(['trotbooks'], 'TrotBooks'), emoji: '🐎'},
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'personal notes');
	if (info!.kind === 'resolved') {
		t.is(info.emoji, '');
	}
});

test('determineProfileForInput leaves emoji undefined when nothing configures one', t => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, 'personal notes');
	if (info!.kind === 'resolved') {
		t.is(info.emoji, undefined);
	}
});

test('determineProfileForInput emoji survives the default-profile fallback', t => {
	const config = createConfig(
		{
			personal: {...createProfile(['personal'], 'Personal'), emoji: '🎸'},
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'something unmatched');
	if (info!.kind === 'resolved') {
		t.true(info.isDefault);
		t.is(info.emoji, '🎸');
	}
});

// ============================================================================
// getStateColors Tests
// ============================================================================

test('getStateColors returns undefined when not configured', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	t.is(getStateColors(config), undefined);
});

test('getStateColors returns undefined for a null config', t => {
	t.is(getStateColors(null), undefined);
});

test('getStateColors returns the configured map', t => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.state_colors = {'In Review': 'cyan'};
	t.deepEqual(getStateColors(config), {'In Review': 'cyan'});
});

// getListLayout — the layout defaults per tracker (beads keys are wide enough
// to crowd a shared row) but an explicit list_view.layout always wins.

const listLayoutConfig = (
	provider?: 'linear' | 'jira' | 'beads',
	layout?: 'single_line' | 'two_line',
) => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	if (provider) config.issue_tracker = {provider};
	if (layout) config.list_view = {layout};
	return config;
};

test('only beads defaults to two_line', t => {
	t.is(getListLayout(listLayoutConfig('beads')), 'two_line');
	t.is(getListLayout(listLayoutConfig('linear')), 'single_line');
	t.is(getListLayout(listLayoutConfig('jira')), 'single_line');
	t.is(getListLayout(listLayoutConfig()), 'single_line');
	t.is(getListLayout(null), 'single_line');
});

test('an explicit list_view.layout overrides the tracker default either way', t => {
	t.is(getListLayout(listLayoutConfig('beads', 'single_line')), 'single_line');
	t.is(getListLayout(listLayoutConfig('linear', 'two_line')), 'two_line');
});

test('an empty list_view block leaves the tracker default standing', t => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.issue_tracker = {provider: 'beads'};
	config.list_view = {};
	t.is(getListLayout(config), 'two_line');
});

test('getPaneWidths maps layout keys onto the three panes', t => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.layout = {rail_width: '10%', claude_width: '45%', companion_width: 70};
	t.deepEqual(getPaneWidths(config), {
		rail: '10%',
		claude: '45%',
		companion: 70,
	});
	t.deepEqual(getPaneWidths(null), {
		rail: undefined,
		claude: undefined,
		companion: undefined,
	});
});

// ============================================================================
// issue_watchlist max_workspaces Validation Tests (STE-25)
// ============================================================================

test('getResolvedWatchlists keeps max_workspaces on an auto-scoped profile watchlist', t => {
	const chaz: Profile = {
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {statuses: ['For Pappardelle'], max_workspaces: 3},
	};
	const resolved = getResolvedWatchlists(createConfig({chaz}, 'chaz'));
	t.deepEqual(resolved[0]!.watchlist.key_prefixes, ['CHAZ']);
	t.is(resolved[0]!.watchlist.max_workspaces, 3);
});

// ============================================================================
// initialization_command — rename + deprecated fallback
// ============================================================================

test('getInitializationCommand prefers the new top-level key', t => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.initialization_command = '/new';
	t.is(getInitializationCommand(config), '/new');
});

test('getInitializationCommand falls back to the deprecated claude spelling', t => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.claude = {initialization_command: '/old'};
	t.is(getInitializationCommand(config), '/old');
});

// ============================================================================
// getAgentProfile — resolution
// ============================================================================

function agentProfileTestConfig(
	overrides: Partial<PappardelleConfig> = {},
): PappardelleConfig {
	const config = createConfig({
		codexy: createProfile(['codexwork'], 'Codexy'),
		plain: createProfile(['plainwork'], 'Plain'),
	});
	return {...config, ...overrides};
}

test('getAgentProfile defaults to the built-in claude agent profile', t => {
	const agentProfile = getAgentProfile(agentProfileTestConfig());
	t.deepEqual(agentProfile, {
		name: 'claude',
		command: 'claude',
		args: '',
		resumeArgs: '--resume {session_id}',
		isClaude: true,
		model: '',
		effort: '',
		modelArgs: '--model {model}',
		effortArgs: '--effort {effort}',
		extraArgs: [],
		skillPrefix: '/',
		rulesArgs: [],
		env: {},
	});
});

test('getAgentProfile trims the trailing newline of a YAML block scalar', t => {
	const config = agentProfileTestConfig({
		agent_profile: 'codex',
		agent_profiles: {
			codex: {command: 'codex\n', args: '--yolo\n', model: 'gpt-5.5\n'},
		},
	});
	t.like(getAgentProfile(config), {command: 'codex', args: '--yolo'});
	t.is(getAgentProfile(config).model, 'gpt-5.5');
});

test('listAgentProfiles labels each agent profile with its config files', t => {
	t.deepEqual(
		listAgentProfiles(
			agentProfileTestConfig({
				agent_profiles: {codex: {command: 'codex'}, aider: {command: 'aider'}},
			}),
			{codex: ['.pappardelle.local.yml', '~/.pappardelle/.pappardelle.yml']},
		),
		[
			{name: 'claude', source: 'built-in'},
			{
				name: 'codex',
				source: '.pappardelle.local.yml + ~/.pappardelle/.pappardelle.yml',
			},
			{name: 'aider', source: 'built-in'},
		],
	);
});

test('checkAgentProfile knows the built-in claude and every configured agent profile, and lists them all for any other name', t => {
	const config = agentProfileTestConfig({
		agent_profiles: {'antigravity-neon:high': {command: 'agy'}},
	});
	t.deepEqual(checkAgentProfile(config, 'claude'), {kind: 'known'});
	t.deepEqual(checkAgentProfile(config, 'antigravity-neon:high'), {
		kind: 'known',
	});
	t.deepEqual(checkAgentProfile(config, 'antigravity-neon'), {
		kind: 'unknown',
		names: ['claude', 'antigravity-neon:high'],
	});
});

test('listAgentProfiles keeps a shadowing claude where it was declared', t => {
	t.deepEqual(
		listAgentProfiles(
			agentProfileTestConfig({
				agent_profiles: {
					codex: {command: 'codex'},
					claude: {command: '/opt/bin/claude'},
				},
			}),
			{codex: ['.pappardelle.yml'], claude: ['.pappardelle.yml']},
		),
		[
			{name: 'codex', source: '.pappardelle.yml'},
			{name: 'claude', source: '.pappardelle.yml'},
		],
	);
});

test('loadAgentProfileSources names every layer that defines an agent profile, the winning one first', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-sources-'));
	const write = (file: string, content: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
		fs.writeFileSync(path.join(dir, file), content);
	};

	write(
		'home/.pappardelle.yml',
		'agent_profiles:\n  codex:\n    command: codex\n',
	);
	write(
		'project/.pappardelle.yml',
		'agent_profiles:\n  opus:\n    command: claude\n',
	);
	write(
		'project/.pappardelle.local.yml',
		'agent_profiles:\n  codex:\n    model: gpt-5.5\n',
	);
	try {
		t.deepEqual(
			loadAgentProfileSources({
				homeConfigDir: path.join(dir, 'home'),
				projectDir: path.join(dir, 'project'),
			}),
			{
				codex: ['.pappardelle.local.yml', '~/.pappardelle/.pappardelle.yml'],
				opus: ['.pappardelle.yml'],
			},
		);
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

test('getAgentProfile resolves a top-level agent_profile reference', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {
				codex: {command: 'codex', args: '--yolo', resume_args: 'resume --last'},
			},
			agent_profile: 'codex',
		}),
	);
	t.is(agentProfile.command, 'codex');
	t.is(agentProfile.args, '--yolo');
	t.is(agentProfile.resumeArgs, 'resume --last');
	t.false(agentProfile.isClaude);
});

test('getAgentProfile resolves a per-profile reference via issue title', t => {
	const config = agentProfileTestConfig({
		agent_profiles: {codex: {command: 'codex'}},
	});
	config.profiles['codexy']!.agent_profile = 'codex';
	t.is(getAgentProfile(config, 'codexwork thing').command, 'codex');
	t.is(getAgentProfile(config, 'plainwork thing').command, 'claude');
	t.is(getAgentProfile(config).command, 'claude');
});

test('getAgentProfile: profile agent_profile "" clears an inherited reference back to claude', t => {
	const config = agentProfileTestConfig({
		agent_profiles: {codex: {command: 'codex'}},
		agent_profile: 'codex',
	});
	config.profiles['plain']!.agent_profile = '';
	t.is(getAgentProfile(config, 'plainwork thing').command, 'claude');
	t.is(getAgentProfile(config, 'codexwork thing').command, 'codex');
});

test('getAgentProfile: shadowed agent_profiles.claude keeps claude gating', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {claude: {command: 'claude', args: '--verbose'}},
		}),
	);
	t.is(agentProfile.args, '--verbose');
	t.true(agentProfile.isClaude);
	t.is(agentProfile.resumeArgs, '--resume {session_id}');
});

test('getAgentProfile: an agent without built-in defaults or resume_args gets no resume', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {aider: {command: 'aider'}},
			agent_profile: 'aider',
		}),
	);
	t.is(agentProfile.resumeArgs, undefined);
});

test('getAgentProfile: is_claude true forces claude treatment for a wrapper', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {local: {command: 'claude-local', is_claude: true}},
			agent_profile: 'local',
		}),
	);
	t.true(agentProfile.isClaude);
	t.is(agentProfile.resumeArgs, '--resume {session_id}');
});

test('getAgentProfile: is_claude false suppresses claude treatment', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {sneaky: {command: 'claude', is_claude: false}},
			agent_profile: 'sneaky',
		}),
	);
	t.false(agentProfile.isClaude);
	t.is(agentProfile.resumeArgs, undefined);
});

test('getAgentProfile: empty resume_args means no resume attempt', t => {
	// '' must behave like the bash resolvers' empty value (launch directly),
	// not slip through into a malformed `base  || … || base` chain.
	const codex = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {codex: {command: 'codex', resume_args: ''}},
			agent_profile: 'codex',
		}),
	);
	t.is(codex.resumeArgs, undefined);

	// Even for claude: an explicit '' opts out of the resume default.
	const claude = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {claude: {command: 'claude', resume_args: ''}},
		}),
	);
	t.is(claude.resumeArgs, undefined);
});

test('getAgentProfile: persisted profile name wins over title matching', t => {
	const config = agentProfileTestConfig({
		agent_profiles: {codex: {command: 'codex'}},
	});
	config.profiles['codexy']!.agent_profile = 'codex';
	// Title has no profile keyword — the persisted profile still selects codex.
	t.is(getAgentProfile(config, 'Fix parser bug', 'codexy').command, 'codex');
	// Persisted name beats a conflicting keyword match.
	t.is(getAgentProfile(config, 'plainwork thing', 'codexy').command, 'codex');
	// A stale name that no longer exists falls back to title matching.
	t.is(getAgentProfile(config, 'codexwork thing', 'deleted').command, 'codex');
	t.is(getAgentProfile(config, 'Fix parser bug', 'deleted').command, 'claude');
});

test('launch fields and companion resolve via the persisted profile name', t => {
	const config = agentProfileTestConfig();
	config.profiles['codexy']!.claude = {model: 'sonnet'};
	config.profiles['codexy']!.companion_command = 'lazygit';
	t.is(getAgentProfile(config, 'Fix parser bug', 'codexy').model, 'sonnet');
	t.is(getCompanionCommand(config, 'Fix parser bug', 'codexy'), 'lazygit');
	// Stale persisted name → title match → top-level defaults.
	t.is(getAgentProfile(config, 'Fix parser bug', 'deleted').model, '');
});

// ============================================================================
// Agent profiles — model and effort
// ============================================================================

test('getAgentProfile gives codex its built-in model and effort flags', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profile: 'codex',
			agent_profiles: {codex: {command: '/opt/bin/codex'}},
		}),
	);
	t.is(agentProfile.modelArgs, '-m {model}');
	t.is(agentProfile.effortArgs, '-c model_reasoning_effort={effort}');
});

test('codex runs skills with $ and other agents with /, unless the agent profile says otherwise', t => {
	const skillPrefix = (agentProfile: string) =>
		getAgentProfile(
			agentProfileTestConfig({
				agent_profile: agentProfile,
				agent_profiles: {
					codex: {command: '/opt/bin/codex --yolo'},
					wrapped: {command: 'codex', skill_prefix: '!'},
					aider: {command: 'aider'},
				},
			}),
		).skillPrefix;
	t.is(skillPrefix('codex'), '$');
	t.is(skillPrefix('claude'), '/');
	t.is(skillPrefix('aider'), '/');
	t.is(skillPrefix('wrapped'), '!');
});

test('getAgentProfile prefers configured flag templates over the built-in ones', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profile: 'codex',
			agent_profiles: {
				codex: {command: 'codex', model_args: '--model={model}'},
			},
		}),
	);
	t.is(agentProfile.modelArgs, '--model={model}');
	t.is(agentProfile.effortArgs, '-c model_reasoning_effort={effort}');
});

test('getAgentProfile gives other CLIs no model or effort flags', t => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profile: 'aider',
			agent_profiles: {aider: {command: 'aider'}},
		}),
	);
	t.is(agentProfile.modelArgs, undefined);
	t.is(agentProfile.effortArgs, undefined);
});

test("an agent profile's own model and effort beat the deprecated claude block", t => {
	const config = agentProfileTestConfig({
		claude: {model: 'sonnet', effort: 'low'},
		agent_profile: 'opus',
		agent_profiles: {opus: {command: 'claude', model: 'opus', effort: 'max'}},
	});
	t.is(getAgentProfile(config).model, 'opus');
	t.is(getAgentProfile(config).effort, 'max');
});

test('a claude agent profile without its own model falls back to the claude block', t => {
	const config = agentProfileTestConfig({
		claude: {model: 'sonnet', effort: 'low'},
		agent_profile: 'mine',
		agent_profiles: {mine: {command: 'claude', effort: 'high'}},
		profiles: {
			codexy: {
				...createProfile(['codexwork'], 'Codexy'),
				claude: {model: 'haiku'},
			},
		},
	});
	t.is(getAgentProfile(config).model, 'sonnet');
	t.is(getAgentProfile(config, 'codexwork').model, 'haiku');
	t.is(getAgentProfile(config).effort, 'high');
});

test('a non-claude agent profile never reads the claude block', t => {
	const config = agentProfileTestConfig({
		claude: {model: 'sonnet', effort: 'low'},
		agent_profile: 'codex',
		agent_profiles: {codex: {command: 'codex'}},
	});
	t.is(getAgentProfile(config).model, '');
	t.is(getAgentProfile(config).effort, '');
});

test("an agent profile's empty model clears the claude block's", t => {
	const config = agentProfileTestConfig({
		claude: {model: 'sonnet'},
		agent_profile: 'plain-claude',
		agent_profiles: {'plain-claude': {command: 'claude', model: ''}},
	});
	t.is(getAgentProfile(config).model, '');
});

test('a config file with broken YAML is reported with the file and line', t => {
	const error = t.throws(
		() =>
			parseConfigLayer(
				'.pappardelle.yml',
				'claude:\n  model: opus\n   extra: x\n',
			),
		{instanceOf: ConfigValidationError},
	);
	t.regex(error!.errors[0]!, /^\.pappardelle\.yml: .*at line \d+, column \d+/);
});

test('YAML merge keys resolve in a config file', t => {
	const layer = parseConfigLayer(
		'.pappardelle.yml',
		[
			'base: &base',
			'  vcs_label: Backend',
			'  team_prefix: BE',
			'profiles:',
			'  api:',
			'    <<: *base',
			'    team_prefix: API',
		].join('\n'),
	);
	t.deepEqual((layer!['profiles'] as Record<string, unknown>)['api'], {
		vcs_label: 'Backend',
		team_prefix: 'API',
	});
});

test('an unknown YAML tag in a config file is reported with the file and line', t => {
	const error = t.throws(
		() => parseConfigLayer('.pappardelle.local.yml', 'a: 1\nemoji: !foo bar\n'),
		{instanceOf: ConfigValidationError},
	);
	t.is(error!.errors.length, 1);
	t.regex(
		error!.errors[0]!,
		/^\.pappardelle\.local\.yml: Unresolved tag: !foo at line 2, column \d+/,
	);
});

test('an undefined YAML alias in a config file is reported with the file', t => {
	const error = t.throws(
		() => parseConfigLayer('.pappardelle.yml', 'emoji: *nope\n'),
		{instanceOf: ConfigValidationError},
	);
	t.regex(error!.errors[0]!, /^\.pappardelle\.yml: .*nope/);
});

// ============================================================================
// list_view.group_by / list_view.groups
// ============================================================================

test('grouping is off unless list_view.group_by is status', t => {
	const config = {version: 1, profiles: {}} as unknown as PappardelleConfig;
	t.false(isRailGroupedByStatus(config));
	config.list_view = {group_by: 'status'};
	t.true(isRailGroupedByStatus(config));
	t.true(
		validateListView({group_by: 'priority'}).includes(
			'list_view.group_by: must be "status"',
		),
	);
});

test('getRailGroups falls back to the default groups', t => {
	t.deepEqual(
		getRailGroups(null).map(group => group.name),
		['In Progress', 'In Review', 'Done'],
	);
});

// ============================================================================
// sous_chef_key
// ============================================================================

test('getSousChefKey defaults to M-s, also when the config failed to load', t => {
	const config = {version: 1, profiles: {}} as unknown as PappardelleConfig;
	t.is(getSousChefKey(config), 'M-s');
	t.is(getSousChefKey(null), 'M-s');
});

test('getSousChefKey returns the configured key, and null when turned off', t => {
	const base = {version: 1, profiles: {}} as unknown as PappardelleConfig;
	t.is(getSousChefKey({...base, sous_chef_key: 'M-j'}), 'M-j');
	t.is(getSousChefKey({...base, sous_chef_key: false}), null);
});
