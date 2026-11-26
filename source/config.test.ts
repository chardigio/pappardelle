import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {thrownBy} from '../test/helpers/thrown.ts';
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

test('getTeamPrefix returns configured team_prefix', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
		'ENG',
	);
	expect(getTeamPrefix(config)).toBe('ENG');
});

test('getTeamPrefix returns default STA when not configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getTeamPrefix(config)).toBe('STA');
});

test('getTeamPrefix uppercases the team prefix', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
		'eng',
	);
	expect(getTeamPrefix(config)).toBe('ENG');
});

// ============================================================================
// Per-Profile Team Prefix Tests
// ============================================================================

test('getProfileTeamPrefix returns profile team_prefix when set', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		team_prefix: 'OTH',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile', 'STA');
	expect(getProfileTeamPrefix(profile, config)).toBe('OTH');
});

test('getProfileTeamPrefix falls back to global team_prefix', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile', 'ENG');
	expect(getProfileTeamPrefix(profile, config)).toBe('ENG');
});

test('getProfileTeamPrefix falls back to STA when neither set', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile');
	expect(getProfileTeamPrefix(profile, config)).toBe('STA');
});

test('getProfileTeamPrefix uppercases profile team_prefix', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		team_prefix: 'oth',
	};
	const config = createConfig({'test-profile': profile}, 'test-profile', 'STA');
	expect(getProfileTeamPrefix(profile, config)).toBe('OTH');
});

test('getProfileTeamPrefix prefers profile over global', () => {
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
	expect(getProfileTeamPrefix(profile, config)).toBe('PROJ');
});

// ============================================================================
// Profile emoji + default_emoji Tests
// ============================================================================

test('getProfileEmoji returns profile emoji when set', () => {
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
	expect(getProfileEmoji(profile, config)).toBe('🍝');
});

test('getProfileEmoji falls back to default_emoji when profile has none', () => {
	const profile: Profile = {keywords: ['test'], display_name: 'Test'};
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'test',
		default_emoji: '🍕',
		profiles: {test: profile},
	};
	expect(getProfileEmoji(profile, config)).toBe('🍕');
});

test('getProfileEmoji returns undefined when neither is set', () => {
	const profile: Profile = {keywords: ['test'], display_name: 'Test'};
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'test',
		profiles: {test: profile},
	};
	expect(getProfileEmoji(profile, config)).toBe(undefined);
});

test('getProfileEmoji uses default_emoji when profile is undefined', () => {
	const config: PappardelleConfig = {
		version: 1,
		default_emoji: '🍕',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	expect(getProfileEmoji(undefined, config)).toBe('🍕');
});

// Regression: a config with no emoji fields anywhere — neither
// `default_emoji` nor any profile `emoji:` — must produce `undefined` from
// getProfileEmoji for every profile. This is what the SpaceListItem renderer
// keys off of to skip the emoji slot entirely and render the row exactly as
// it did on master. If this ever returns a string, every existing user gets
// an unexpected blank slot in their TUI on the next upgrade.
test('emoji-free config: getProfileEmoji returns undefined for every profile', () => {
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
		expect(
			getProfileEmoji(profile, config),
			'no emoji fields anywhere should yield undefined (master UI preserved)',
		).toBe(undefined);
	}

	// Also: undefined profile (e.g., main worktree path) must stay undefined.
	expect(getProfileEmoji(undefined, config)).toBe(undefined);
});

test('partial emoji config: profiles without emoji fall back to default_emoji', () => {
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
	expect(getProfileEmoji(config.profiles['a']!, config)).toBe('🎸');
	expect(getProfileEmoji(config.profiles['b']!, config)).toBe('');
});

// Footgun guard: if the user sets an `emoji:` on some profiles but forgets
// `default_emoji`, we auto-promote to `''` (blank slot) for the rest so
// rows stay aligned. Without this, one profile's emoji would silently
// jut every other row's row out of alignment by 3 cells.
test('footgun guard: any profile emoji + no default_emoji → "" for unset profiles', () => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
			b: {keywords: ['b'], display_name: 'B'}, // no emoji
			c: {keywords: ['c'], display_name: 'C'}, // no emoji
		},
	};
	expect(getProfileEmoji(config.profiles['a']!, config)).toBe('🎸');
	expect(
		getProfileEmoji(config.profiles['b']!, config),
		'unset profile should inherit auto-blank slot so rows line up',
	).toBe('');
	expect(
		getProfileEmoji(config.profiles['c']!, config),
		'unset profile should inherit auto-blank slot so rows line up',
	).toBe('');
	expect(
		getProfileEmoji(undefined, config),
		'main worktree (undefined profile) should also inherit the auto-blank slot',
	).toBe('');
});

// Same guard applies when the profile's emoji is explicitly empty — the
// "any other profile has an emoji" check counts empty-string as set.
test('footgun guard: explicit "" on one profile still promotes unset siblings', () => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: ''},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	expect(getProfileEmoji(config.profiles['a']!, config)).toBe('');
	expect(getProfileEmoji(config.profiles['b']!, config)).toBe('');
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
test('resolvePendingProfileEmoji: emoji-free config → undefined regardless of profileName', () => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A'},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	expect(resolvePendingProfileEmoji(config, null)).toBe(undefined);
	expect(resolvePendingProfileEmoji(config, undefined)).toBe(undefined);
	expect(resolvePendingProfileEmoji(config, 'a')).toBe(undefined);
	expect(resolvePendingProfileEmoji(config, 'unknown-profile')).toBe(undefined);
});

test('resolvePendingProfileEmoji: null config → undefined (load failure path)', () => {
	expect(resolvePendingProfileEmoji(null, null)).toBe(undefined);
	expect(resolvePendingProfileEmoji(null, 'whatever')).toBe(undefined);
});

test('resolvePendingProfileEmoji: known profileName → that profile emoji', () => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '🍕',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
			b: {keywords: ['b'], display_name: 'B'},
		},
	};
	expect(resolvePendingProfileEmoji(config, 'a')).toBe('🎸');
});

test('resolvePendingProfileEmoji: known profileName w/o emoji → default_emoji fallback', () => {
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '🍕',
		profiles: {
			a: {keywords: ['a'], display_name: 'A'}, // no emoji on profile
		},
	};
	expect(resolvePendingProfileEmoji(config, 'a')).toBe('🍕');
});

test('resolvePendingProfileEmoji: no profileName, default_emoji set → default_emoji', () => {
	// Description-route ("Starting new session…") never knows the profile
	// upfront — the user just typed free text. Must still pick up the
	// default emoji so the slot is reserved.
	const config: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		default_emoji: '🍝',
		profiles: {a: {keywords: ['a'], display_name: 'A'}},
	};
	expect(resolvePendingProfileEmoji(config, null)).toBe('🍝');
	expect(resolvePendingProfileEmoji(config, undefined)).toBe('🍝');
});

test('resolvePendingProfileEmoji: no profileName, footgun guard active → "" blank slot', () => {
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
	expect(resolvePendingProfileEmoji(config, null)).toBe('');
});

test('resolvePendingProfileEmoji: unknown profileName → falls back as if undefined', () => {
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
	expect(resolvePendingProfileEmoji(configWithDefault, 'does-not-exist')).toBe(
		'🍕',
	);

	// Footgun-guard path: no `default_emoji` but a profile has `emoji:` →
	// `''` blank slot for unknown profileName too.
	const configWithFootgun: PappardelleConfig = {
		version: 1,
		default_profile: 'a',
		profiles: {
			a: {keywords: ['a'], display_name: 'A', emoji: '🎸'},
		},
	};
	expect(resolvePendingProfileEmoji(configWithFootgun, 'does-not-exist')).toBe(
		'',
	);
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

test('buildWorkspaceTemplateVars sets base variables', () => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
	);
	expect(vars.ISSUE_KEY).toBe('STA-999');
	expect(vars.WORKTREE_PATH).toBe('/tmp/worktree');
	expect(vars.REPO_ROOT).toBeTruthy();
	expect(vars.REPO_NAME).toBeTruthy();
	expect(vars.SCRIPT_DIR).toBeTruthy();
});

test('buildWorkspaceTemplateVars prefers an explicit profileName over the title match', () => {
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
	expect(vars['IOS_APP_DIR']).toBe(undefined);
	expect(vars['SCHEME']).toBe(undefined);
});

test('buildWorkspaceTemplateVars uses the named profile vars even when the title matches nothing', () => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'unrelated title',
		'stardust-jams',
	);
	expect(vars['IOS_APP_DIR']).toBe('_ios/stardust-jams');
	expect(vars['SCHEME']).toBe('stardust-jams');
});

test('buildWorkspaceTemplateVars falls back to the title match for an unknown profileName', () => {
	// A stale profile name persisted in space-state must not strip the vars.
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug',
		'deleted_profile',
	);
	expect(vars['IOS_APP_DIR']).toBe('_ios/stardust-jams');
});

test('buildWorkspaceTemplateVars merges profile vars when title matches', () => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug',
	);
	// Profile vars from stardust-jams profile should be merged
	expect(vars['IOS_APP_DIR']).toBe('_ios/stardust-jams');
	expect(vars['BUNDLE_ID']).toBe('io.stardustlabs.stardust');
	expect(vars['SCHEME']).toBe('stardust-jams');
});

test('buildWorkspaceTemplateVars sets VCS label from matched profile', () => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug',
	);
	expect(vars.VCS_LABEL).toBe('stardust_jams');
	expect(vars.GITHUB_LABEL).toBe('stardust_jams');
});

test('buildWorkspaceTemplateVars falls back to default profile when no title match', () => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'zzz nonexistent topic',
	);
	// Default profile is "pappardelle" which has no vars, so custom vars should be absent
	expect(vars['IOS_APP_DIR']).toBe(undefined);
	expect(vars['BUNDLE_ID']).toBe(undefined);
});

test('buildWorkspaceTemplateVars falls back to default profile when no title provided', () => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
	);
	// No title = no match = falls back to default profile (pappardelle, no vars)
	expect(vars['IOS_APP_DIR']).toBe(undefined);
});

test('buildWorkspaceTemplateVars does not overwrite base vars with profile vars', () => {
	const vars = buildWorkspaceTemplateVars(
		'STA-999',
		'/tmp/worktree',
		templateVarsTestConfig,
		'fix stardust jams bug',
	);
	// Base vars should remain even though profile vars were merged
	expect(vars.ISSUE_KEY).toBe('STA-999');
	expect(vars.WORKTREE_PATH).toBe('/tmp/worktree');
});

// ============================================================================
// Basic Matching Tests
// ============================================================================

test('matches exact keyword', () => {
	const config = createConfig({
		'test-profile': createProfile(['pappardelle'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'pappardelle');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('test-profile');
	expect(matches[0]!.matchedKeywords).toStrictEqual(['pappardelle']);
});

test('matches keyword case-insensitively', () => {
	const config = createConfig({
		'test-profile': createProfile(['Pappardelle'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'PAPPARDELLE');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('test-profile');
});

test('matches keyword within sentence', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle', 'tui', 'dow'], 'Pappardelle'),
	});

	const matches = matchProfiles(
		config,
		'fix the pappardelle profile detection',
	);
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
	expect(matches[0]!.matchedKeywords).toStrictEqual(['pappardelle']);
});

test('returns empty array when no match', () => {
	const config = createConfig({
		'test-profile': createProfile(['foo', 'bar'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'baz qux');
	expect(matches.length).toBe(0);
});

// ============================================================================
// Multiple Profile Tests (Priority/Tie-breaking)
// ============================================================================

test('prioritizes profile with more keyword matches', () => {
	const config = createConfig({
		'profile-a': createProfile(['foo'], 'Profile A'),
		'profile-b': createProfile(['foo', 'bar'], 'Profile B'),
	});

	const matches = matchProfiles(config, 'foo bar');
	expect(matches.length).toBe(2);
	expect(matches[0]!.name).toBe('profile-b');
	expect(matches[0]!.score).toBe(2);
});

test('returns pappardelle for pappardelle-related prompts, not stardust-jams', () => {
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
	expect(matches.length >= 1).toBe(true);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('both profiles match when input contains prefixes for both', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	// "tracking" prefix-matches "track", "pappardelle" exact-matches "pappardelle"
	const matches = matchProfiles(config, 'pappardelle tracking test');
	expect(matches.length).toBe(2);
});

// ============================================================================
// Prefix Matching Tests
// ============================================================================

test('SHOULD match "track" keyword when input has "tracking"', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'tracking the issue');
	expect(
		matches.length,
		'"tracking" starts with "track" so it should match',
	).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
});

test('SHOULD match "record" keyword when input has "recording"', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['record'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'recording a video');
	expect(
		matches.length,
		'"recording" starts with "record" so it should match',
	).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
});

test('SHOULD NOT match "music" keyword when input has "mu"', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'mu test');
	expect(matches.length, '"mu" does not start with "music"').toBe(0);
});

test('SHOULD match exact word even with punctuation nearby', () => {
	const config = createConfig({
		'test-profile': createProfile(['pappardelle'], 'Test Profile'),
	});

	// Note: This depends on how we split words - may need adjustment
	const matches = matchProfiles(config, 'fix pappardelle,now');
	expect(matches.length >= 1).toBe(true);
	expect(matches[0]!.name).toBe('test-profile');
});

// ============================================================================
// Prefix Matching with Hyphens
// ============================================================================

test('"SHOP-" keyword matches "SHOP-313"', () => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	const matches = matchProfiles(config, 'working on SHOP-313 today');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('shop');
	expect(matches[0]!.matchedKeywords).toStrictEqual(['SHOP-']);
});

test('prefix keyword matches various suffixes', () => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	for (const input of ['SHOP-1', 'SHOP-999', 'SHOP-abc', 'fix SHOP-42 bug']) {
		const matches = matchProfiles(config, input);
		expect(matches.length, `"SHOP-" should match "${input}"`).toBe(1);
		expect(matches[0]!.name).toBe('shop');
	}
});

test('prefix keyword is case-insensitive', () => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	const matches = matchProfiles(config, 'shop-42 is broken');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('shop');
});

test('hyphenated keyword does NOT match word missing the hyphen', () => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	// "shop" does not start with "shop-"
	const matches = matchProfiles(config, 'shop is broken');
	expect(matches.length, '"shop" does not start with "shop-"').toBe(0);
});

test('multiple prefix keywords can match from different profiles', () => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
		warehouse: createProfile(['WH-'], 'Warehouse'),
	});

	const matches = matchProfiles(config, 'SHOP-42 needs WH-7 stock');
	expect(matches.length).toBe(2);
});

// ============================================================================
// Keyword Buried Inside a Hyphen-Joined Input Word (STA-927)
// ============================================================================

test('keyword buried inside a hyphen-joined input word still matches', () => {
	// Regression for STA-927: "something-keyword-something" should match
	// keyword "keyword" — previously the input was treated as a single word
	// that did not start with the keyword, so it silently failed.
	const config = createConfig({
		'test-profile': createProfile(['keyword'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'something-keyword-something');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('test-profile');
	expect(matches[0]!.matchedKeywords).toStrictEqual(['keyword']);
});

test('keyword buried in hyphenated word matches case-insensitively', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'Fix-MUSIC-Bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
});

test('prefix keyword matches buried hyphen-joined sub-token (e.g. "spot" → "add-spotify")', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['spot'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'add-spotify-integration');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
});

test('multiple distinct keywords buried in same hyphen-joined word both match', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music', 'spotify'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'fix-music-spotify-bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.score).toBe(2);
	expect(matches[0]!.matchedKeywords.sort()).toStrictEqual([
		'music',
		'spotify',
	]);
});

test('buried keyword does not bleed across whitespace word boundaries', () => {
	// "mu" is a sub-token of "mu-foo" but it does not start with "music",
	// so a profile keyworded "music" must not match.
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'mu-foo bar');
	expect(matches.length, '"mu" sub-token does not start with "music"').toBe(0);
});

test('regression: "shop" alone still does not match "SHOP-" keyword after hyphen-aware fix', () => {
	// Pin: the trailing-hyphen keyword "SHOP-" must still REJECT bare "shop"
	// inputs, even after the fix walks hyphen sub-tokens. This is what makes
	// "SHOP-" distinct from "SHOP" and prevents false-positive matches on
	// unrelated words like "shopping" or "shopkeeper".
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	expect(matchProfiles(config, 'shop is broken').length).toBe(0);
	expect(matchProfiles(config, 'fix-shop-bug').length).toBe(0);
});

test('regression: hyphen-aware fix still respects multi-word keyword adjacency in plain input', () => {
	// Pin existing whitespace-adjacency semantics for multi-word keywords.
	// The third assertion pins the *intentional* non-wiring of subTokens into
	// the multi-word branch: a hyphenated input like "fix-venue-page" must NOT
	// match keyword "venue page" today. If a future change extends the
	// multi-word branch to also walk sub-tokens, this assertion will go red
	// and force a deliberate decision instead of a silent behavior shift.
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	expect(matchProfiles(config, 'venue detail page').length).toBe(0);
	expect(matchProfiles(config, 'fix the venue page').length).toBe(1);
	expect(
		matchProfiles(config, 'fix-venue-page').length,
		'hyphenated input does not bypass multi-word adjacency requirement',
	).toBe(0);
});

// ============================================================================
// Real-world Scenario Tests
// ============================================================================

test('pappardelle profile for dow/idow related prompts', () => {
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

	expect(matchProfiles(config, 'fix the dow script')[0]?.name).toBe(
		'pappardelle',
	);
	expect(matchProfiles(config, 'idow is broken')[0]?.name).toBe('pappardelle');
	expect(matchProfiles(config, 'update tui colors')[0]?.name).toBe(
		'pappardelle',
	);
});

test('stardust-jams profile for music-related prompts', () => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['stardust', 'jams', 'music', 'spotify', 'playlist'],
			'Stardust Jams',
		),
		pappardelle: createProfile(['pappardelle', 'tui', 'dow'], 'Pappardelle'),
	});

	expect(matchProfiles(config, 'add spotify integration')[0]?.name).toBe(
		'stardust-jams',
	);
	expect(matchProfiles(config, 'create new playlist feature')[0]?.name).toBe(
		'stardust-jams',
	);
	expect(matchProfiles(config, 'fix music player bug')[0]?.name).toBe(
		'stardust-jams',
	);
});

test('king-bee profile for hive/spelling related prompts', () => {
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

	expect(matchProfiles(config, 'fix the hive puzzle')[0]?.name).toBe(
		'king-bee',
	);
	expect(matchProfiles(config, 'spelling bee scoring bug')[0]?.name).toBe(
		'king-bee',
	);
});

test('no false positives from common words', () => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['track', 'album', 'artist'],
			'Stardust Jams',
		),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	// Words like "a", "the", "is", "it" should not match anything
	const matches = matchProfiles(config, 'a the is it and or');
	expect(matches.length).toBe(0);
});

// ============================================================================
// Multi-word Keyword Matching Tests
// ============================================================================

test('matches multi-word keyword as adjacent phrase', () => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix the venue page layout');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('venue-profile');
	expect(matches[0]!.matchedKeywords).toStrictEqual(['venue page']);
});

test('does NOT match multi-word keyword when words are non-adjacent', () => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'venue detail page');
	expect(matches.length).toBe(0);
});

test('does NOT match multi-word keyword when only partial words appear', () => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix venue layout');
	expect(matches.length).toBe(0);
});

test('matches multi-word keyword case-insensitively', () => {
	const config = createConfig({
		'venue-profile': createProfile(['Venue Page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix the VENUE PAGE bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('venue-profile');
});

test('matches mix of single-word and multi-word keywords', () => {
	const config = createConfig({
		'mixed-profile': createProfile(
			['venue page', 'map', 'location detail'],
			'Mixed Profile',
		),
	});

	const matches = matchProfiles(config, 'fix the venue page map');
	expect(matches.length).toBe(1);
	expect(matches[0]!.score).toBe(2);
	expect(matches[0]!.matchedKeywords).toStrictEqual(['venue page', 'map']);
});

test('multi-word keyword scores 1 like single-word keyword', () => {
	const config = createConfig({
		'profile-a': createProfile(['venue page'], 'Profile A'),
		'profile-b': createProfile(['venue'], 'Profile B'),
	});

	const matches = matchProfiles(config, 'venue page test');
	// Both should match; profile-a matches "venue page", profile-b matches "venue"
	expect(matches.length).toBe(2);
	// Both have score 1
	expect(matches[0]!.score).toBe(1);
	expect(matches[1]!.score).toBe(1);
});

test('multi-word keyword at start of input', () => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'venue page needs fixing');
	expect(matches.length).toBe(1);
});

test('multi-word keyword at end of input', () => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	const matches = matchProfiles(config, 'fix the venue page');
	expect(matches.length).toBe(1);
});

test('multi-word keyword with punctuation between words in input', () => {
	const config = createConfig({
		'venue-profile': createProfile(['venue page'], 'Venue Profile'),
	});

	// Words separated by comma - the splitter should still produce adjacent words
	const matches = matchProfiles(config, 'fix venue,page layout');
	expect(matches.length).toBe(1);
});

test('three-word keyword matches', () => {
	const config = createConfig({
		'detail-profile': createProfile(['venue detail page'], 'Detail Profile'),
	});

	const matches = matchProfiles(config, 'fix the venue detail page layout');
	expect(matches.length).toBe(1);
	expect(matches[0]!.matchedKeywords).toStrictEqual(['venue detail page']);
});

test('three-word keyword does NOT match with wrong order', () => {
	const config = createConfig({
		'detail-profile': createProfile(['venue detail page'], 'Detail Profile'),
	});

	const matches = matchProfiles(config, 'venue page detail');
	expect(matches.length).toBe(0);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('empty keyword does not match any input', () => {
	const config = createConfig({
		'bad-profile': createProfile(['', '   '], 'Bad Profile'),
	});

	const matches = matchProfiles(config, 'anything here');
	expect(matches.length).toBe(0);
});

test('handles empty input', () => {
	const config = createConfig({
		'test-profile': createProfile(['foo'], 'Test Profile'),
	});

	const matches = matchProfiles(config, '');
	expect(matches.length).toBe(0);
});

test('handles whitespace-only input', () => {
	const config = createConfig({
		'test-profile': createProfile(['foo'], 'Test Profile'),
	});

	const matches = matchProfiles(config, '   \t\n  ');
	expect(matches.length).toBe(0);
});

test('handles single character input', () => {
	const config = createConfig({
		'test-profile': createProfile(['a'], 'Test Profile'),
	});

	const matches = matchProfiles(config, 'a');
	expect(matches.length).toBe(1);
});

test('handles hyphenated keywords', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['stardust-jams'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'fix stardust-jams bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
});

// ============================================================================
// Special Character Tests
// ============================================================================

test('matches keyword in parentheses', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix (pappardelle) bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with trailing parenthesis', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'pappardelle) is broken');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with leading parenthesis', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix (pappardelle today');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword in square brackets', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix [pappardelle] bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword in curly braces', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix {pappardelle} bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with forward slash', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix pappardelle/config issue');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with backslash', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix pappardelle\\config issue');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with single quotes', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, "fix 'pappardelle' bug");
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with double quotes', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix "pappardelle" bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with underscore prefix', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix _pappardelle module');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with underscore suffix', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix pappardelle_ module');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with hyphen prefix', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix -pappardelle option');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with at symbol', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix @pappardelle/cli bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with hash symbol', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '#pappardelle needs fix');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with backticks', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix `pappardelle` command');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword surrounded by multiple special chars', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix ["pappardelle"] bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with ampersand', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
		config: createProfile(['config'], 'Config'),
	});

	const matches = matchProfiles(config, 'pappardelle & config');
	expect(matches.length).toBe(2);
	expect(matches.some(m => m.name === 'pappardelle')).toBe(true);
	expect(matches.some(m => m.name === 'config')).toBe(true);
});

test('matches keyword with pipe symbol', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'pappardelle | grep something');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with angle brackets', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'fix <pappardelle> component');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with equals sign', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'profile=pappardelle issue');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with plus sign', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'pappardelle+config feature');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with percent sign', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '%pappardelle variable');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with caret', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '^pappardelle regex');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with asterisk', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '*pappardelle* important');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with tilde', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '~pappardelle path');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches keyword with dollar sign', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '$pappardelle environment var');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
});

test('matches multiple keywords with mixed special chars', () => {
	const config = createConfig({
		pappardelle: createProfile(['pappardelle', 'tui', 'dow'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, '(pappardelle) [tui] {dow}');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
	expect(matches[0]!.score).toBe(3);
	expect(matches[0]!.matchedKeywords.sort()).toStrictEqual([
		'dow',
		'pappardelle',
		'tui',
	]);
});

// ============================================================================
// Keyword Enforcement (!) Tests
// ============================================================================

test('! after keyword enforces that profile', () => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['music', 'spotify', 'track'],
			'Stardust Jams',
		),
		'king-bee': createProfile(['bee', 'hive', 'spelling'], 'King Bee'),
	});

	// "music!" should enforce stardust-jams even though "bee" matches king-bee
	const matches = matchProfiles(config, 'fix the music! and bee stuff');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(true);
});

test('! enforcement wins over higher-scoring non-enforced profile', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee', 'hive', 'spelling'], 'King Bee'),
	});

	// "music!" enforces stardust-jams even though king-bee has more keyword matches
	const matches = matchProfiles(config, 'music! bee hive spelling');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(true);
});

test('! enforcement with prefix matching', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	// "tracking!" should enforce stardust-jams via prefix match on "track"
	const matches = matchProfiles(config, 'tracking! pappardelle issue');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(true);
});

test('! enforcement is case-insensitive', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	const matches = matchProfiles(config, 'MUSIC! bee');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(true);
});

test('! on non-keyword word falls back to normal matching', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	// "fix!" is not a keyword for any profile, so fall back to normal matching
	const matches = matchProfiles(config, 'fix! the music and bee');
	expect(matches.length).toBe(2);
	expect(matches[0]!.enforced).toBe(false);
});

test('multiple ! keywords from same profile', () => {
	const config = createConfig({
		'stardust-jams': createProfile(
			['music', 'spotify', 'track'],
			'Stardust Jams',
		),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	const matches = matchProfiles(config, 'music! spotify! bee');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(true);
});

test('multiple ! keywords from different profiles returns both enforced', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
		'king-bee': createProfile(['bee'], 'King Bee'),
	});

	const matches = matchProfiles(config, 'music! bee!');
	expect(matches.length).toBe(2);
	expect(matches[0]!.enforced).toBe(true);
	expect(matches[1]!.enforced).toBe(true);
});

test('! alone without preceding word does not enforce', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, '! music');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(false);
});

test('no ! in input means enforced is false', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'music player bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(false);
});

test('! enforcement with hyphenated keyword', () => {
	const config = createConfig({
		'stardust-jams': createProfile(['stardust-jams'], 'Stardust Jams'),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'stardust-jams! pappardelle bug');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('stardust-jams');
	expect(matches[0]!.enforced).toBe(true);
});

test('real-world: enforce pappardelle over stardust-jams', () => {
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
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('pappardelle');
	expect(matches[0]!.enforced).toBe(true);
});

// ============================================================================
// Repo Name from Git Common Dir Tests
// ============================================================================

test('repoNameFromGitCommonDir extracts repo name from main repo .git path', () => {
	expect(repoNameFromGitCommonDir('/Users/charlie/cs/stardust-labs/.git')).toBe(
		'stardust-labs',
	);
});

test('repoNameFromGitCommonDir extracts repo name from worktree .git path', () => {
	// git common dir is always the main repo's .git, even from a worktree
	expect(repoNameFromGitCommonDir('/Users/charlie/cs/my-project/.git')).toBe(
		'my-project',
	);
});

test('repoNameFromGitCommonDir handles trailing slash', () => {
	expect(
		repoNameFromGitCommonDir('/Users/charlie/cs/stardust-labs/.git/'),
	).toBe('stardust-labs');
});

test('repoNameFromGitCommonDir handles relative .git path', () => {
	// Edge case: relative path — dirname of ".git" is "."
	expect(repoNameFromGitCommonDir('.git')).toBe('.');
});

// ============================================================================
// getProfileVcsLabel Tests
// ============================================================================

test('getProfileVcsLabel returns vcs.label when set', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		vcs: {label: 'my_label'},
		github: {label: 'gh_label'},
	};
	expect(getProfileVcsLabel(profile)).toBe('my_label');
});

test('getProfileVcsLabel falls back to github.label', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		github: {label: 'gh_label'},
	};
	expect(getProfileVcsLabel(profile)).toBe('gh_label');
});

test('getProfileVcsLabel returns undefined when neither set', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
	};
	expect(getProfileVcsLabel(profile)).toBe(undefined);
});

test('getProfileVcsLabel prefers vcs.label over github.label', () => {
	const profile: Profile = {
		keywords: ['test'],
		display_name: 'Test',
		vcs: {label: 'vcs_first'},
		github: {label: 'gh_second'},
	};
	expect(getProfileVcsLabel(profile)).toBe('vcs_first');
});

// ============================================================================
// getDangerouslySkipPermissions Tests
// ============================================================================

test('getDangerouslySkipPermissions returns true when configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.claude = {dangerously_skip_permissions: true};
	expect(getDangerouslySkipPermissions(config)).toBe(true);
});

test('getDangerouslySkipPermissions returns false when configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.claude = {dangerously_skip_permissions: false};
	expect(getDangerouslySkipPermissions(config)).toBe(false);
});

test('getDangerouslySkipPermissions returns false when not configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getDangerouslySkipPermissions(config)).toBe(false);
});

test('getDangerouslySkipPermissions returns false when claude section exists but no flag', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.claude = {initialization_command: '/idow'};
	expect(getDangerouslySkipPermissions(config)).toBe(false);
});

// ============================================================================
// Keybinding Tests
// ============================================================================

test('getKeybindings returns empty array when not configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getKeybindings(config)).toStrictEqual([]);
});

test('getKeybindings returns configured keybindings', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.keybindings = [
		{key: 'b', name: 'Build', run: 'make build'},
		{key: 't', name: 'Test', run: 'make test'},
	];
	const bindings = getKeybindings(config);
	expect(bindings.length).toBe(2);
	expect(bindings[0]!.key).toBe('b');
	expect(bindings[0]!.name).toBe('Build');
	expect(bindings[1]!.key).toBe('t');
});

test('getKeybindings returns send_to_claude keybindings', () => {
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
	expect(bindings.length).toBe(2);
	expect(bindings[1]!.key).toBe('a');
	expect(bindings[1]!.send_to_claude).toBe('/address-pr-feedback');
	expect(bindings[1]!.run).toBe(undefined);
});

// ============================================================================
// Optional default_profile Tests
// ============================================================================

test('getDefaultProfile falls back to first profile when default_profile is undefined', () => {
	const config = createConfig(
		{'first-profile': createProfile(['test'], 'First')},
		undefined,
	);
	const result = getDefaultProfile(config);
	expect(result.name).toBe('first-profile');
	expect(result.profile.display_name).toBe('First');
});

// ============================================================================
// Optional keywords Tests
// ============================================================================

test('profile without keywords never matches in matchProfiles', () => {
	const config = createConfig(
		{
			'no-kw': {display_name: 'No Keywords'},
			'has-kw': createProfile(['foo'], 'Has Keywords'),
		},
		'no-kw',
	);
	const matches = matchProfiles(config, 'foo bar');
	expect(matches.length).toBe(1);
	expect(matches[0]!.name).toBe('has-kw');
});

// ============================================================================
// mergeKeybindings Tests
// ============================================================================

test('mergeKeybindings returns base keybindings when local is empty', () => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
		{key: 't', name: 'Test', run: 'make test'},
	];
	const result = mergeKeybindings(base, []);
	expect(result).toStrictEqual(base);
});

test('mergeKeybindings adds new keybindings from local', () => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
	];
	const local: KeybindingConfig[] = [
		{key: 'v', name: 'Open in VS Code', run: 'code .'},
	];
	const result = mergeKeybindings(base, local);
	expect(result.length).toBe(2);
	expect(result[0]!.key).toBe('b');
	expect(result[1]!.key).toBe('v');
	expect(result[1]!.name).toBe('Open in VS Code');
});

test('mergeKeybindings overrides existing key with local version', () => {
	const base: KeybindingConfig[] = [
		{key: 'x', name: 'Open in Cursor', run: 'cursor .'},
		{key: 'b', name: 'Build', run: 'make build'},
	];
	const local: KeybindingConfig[] = [
		{key: 'x', name: 'Open in Nova', run: 'nova .'},
	];
	const result = mergeKeybindings(base, local);
	expect(result.length).toBe(2);
	const xBinding = result.find(kb => kb.key === 'x')!;
	expect(xBinding.name).toBe('Open in Nova');
	expect(xBinding.run).toBe('nova .');
});

test('mergeKeybindings removes disabled keybindings', () => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
		{key: 'r', name: 'Run', run: 'make run'},
		{key: 't', name: 'Test', run: 'make test'},
	];
	const local: KeybindingConfig[] = [{key: 'r', name: '', disabled: true}];
	const result = mergeKeybindings(base, local);
	expect(result.length).toBe(2);
	expect(result[0]!.key).toBe('b');
	expect(result[1]!.key).toBe('t');
});

test('mergeKeybindings handles add, override, and disable together', () => {
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
	expect(result.length).toBe(3);
	const keys = result.map(kb => kb.key);
	expect(keys).toStrictEqual(['b', 'x', 'v']);
	expect(result.find(kb => kb.key === 'x')!.name).toBe('Open Nova');
});

test('mergeKeybindings returns empty array when both are empty', () => {
	const result = mergeKeybindings([], []);
	expect(result).toStrictEqual([]);
});

test('mergeKeybindings with only local keybindings (empty base)', () => {
	const local: KeybindingConfig[] = [
		{key: 'v', name: 'VS Code', run: 'code .'},
	];
	const result = mergeKeybindings([], local);
	expect(result.length).toBe(1);
	expect(result[0]!.key).toBe('v');
});

test('mergeKeybindings: disabling a non-existent key is a no-op', () => {
	const base: KeybindingConfig[] = [
		{key: 'b', name: 'Build', run: 'make build'},
	];
	const local: KeybindingConfig[] = [{key: 'z', name: '', disabled: true}];
	const result = mergeKeybindings(base, local);
	expect(result).toStrictEqual(base);
});

// ============================================================================
// getIssueWatchlist Tests
// ============================================================================

test('getIssueWatchlist returns undefined when not configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getIssueWatchlist(config)).toBe(undefined);
});

test('getIssueWatchlist returns the configured watchlist', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.issue_watchlist = {
		assignee: 'me',
		statuses: ['To Do', 'In Progress'],
	};
	const watchlist = getIssueWatchlist(config);
	expect(watchlist).toBeTruthy();
	expect(watchlist!.assignee).toBe('me');
	expect(watchlist!.statuses).toStrictEqual(['To Do', 'In Progress']);
});

test('getIssueWatchlist returns labels when configured', () => {
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
	expect(watchlist!.labels).toStrictEqual(['pappardelle', 'platform']);
});

// ============================================================================
// getResolvedWatchlists Tests (per-profile issue_watchlist)
// ============================================================================

test('getResolvedWatchlists returns [] when nothing is configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getResolvedWatchlists(config)).toStrictEqual([]);
});

test('getResolvedWatchlists returns only the top-level watchlist when no profile defines one (off-by-default regression)', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	expect(getResolvedWatchlists(config)).toStrictEqual([
		{profileName: null, watchlist: {assignee: 'me', statuses: ['To Do']}},
	]);
});

test('getResolvedWatchlists never auto-scopes the top-level watchlist even when team_prefix is set', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
		'STA',
	);
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	const resolved = getResolvedWatchlists(config);
	expect(resolved.length).toBe(1);
	expect(resolved[0]!.profileName).toBe(null);
	expect(resolved[0]!.watchlist.key_prefixes).toBe(undefined);
});

test('getResolvedWatchlists includes profile watchlists additively after the top-level one', () => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
	};
	const config = createConfig({chaz}, 'chaz');
	config.issue_watchlist = {assignee: 'me', statuses: ['To Do']};
	const resolved = getResolvedWatchlists(config);
	expect(resolved.length).toBe(2);
	expect(resolved[0]!.profileName).toBe(null);
	expect(resolved[1]!.profileName).toBe('chaz');
});

test('getResolvedWatchlists includes every profile that defines a watchlist', () => {
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
	expect(resolved.length).toBe(3);
	expect(new Set(resolved.map(r => r.profileName))).toStrictEqual(
		new Set([null, 'chaz', 'jams']),
	);
});

test('getResolvedWatchlists orders the top-level watchlist first, then profiles in definition order', () => {
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
	expect(resolved.map(r => r.profileName)).toStrictEqual([
		null,
		'bravo',
		'alpha',
	]);
});

test('getResolvedWatchlists auto-scopes a profile watchlist to the profile team_prefix', () => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
	};
	const config = createConfig({chaz}, 'chaz');
	const resolved = getResolvedWatchlists(config);
	expect(resolved.length).toBe(1);
	expect(resolved[0]!.watchlist.key_prefixes).toStrictEqual(['CHAZ']);
	// The source config object must not be mutated by resolution.
	expect(chaz.issue_watchlist!.key_prefixes).toBe(undefined);
});

test('getResolvedWatchlists auto-scopes a profile watchlist to the global team_prefix when the profile has none', () => {
	const foo: Profile = {
		keywords: ['foo'],
		display_name: 'Foo',
		issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
	};
	const config = createConfig({foo}, 'foo', 'STA');
	const resolved = getResolvedWatchlists(config);
	expect(resolved[0]!.watchlist.key_prefixes).toStrictEqual(['STA']);
});

test('getResolvedWatchlists leaves an explicit profile key_prefixes untouched (explicit wins over auto-scope)', () => {
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
	expect(resolved[0]!.watchlist.key_prefixes).toStrictEqual(['WAB']);
});

test('getResolvedWatchlists treats an empty profile key_prefixes as omitted and auto-scopes', () => {
	const chaz: Profile = {
		keywords: ['chaz'],
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {assignee: 'me', statuses: ['X'], key_prefixes: []},
	};
	const config = createConfig({chaz}, 'chaz');
	const resolved = getResolvedWatchlists(config);
	expect(resolved[0]!.watchlist.key_prefixes).toStrictEqual(['CHAZ']);
});

test('getResolvedWatchlists leaves a profile watchlist unscoped when no team_prefix is configured anywhere', () => {
	const foo: Profile = {
		keywords: ['foo'],
		display_name: 'Foo',
		issue_watchlist: {assignee: 'me', statuses: ['X']},
	};
	const config = createConfig({foo}, 'foo');
	const resolved = getResolvedWatchlists(config);
	// No explicit prefixes and nothing to derive from → unscoped (matches all).
	expect(resolved[0]!.watchlist.key_prefixes).toBe(undefined);
});

// ============================================================================
// issue_watchlist key_prefixes Validation Tests
// ============================================================================

test('getIssueWatchlist returns key_prefixes when configured', () => {
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
	expect(watchlist!.key_prefixes).toStrictEqual(['STA']);
});

// ============================================================================
// getAutoRemoveWhenDone Tests
// ============================================================================

test('getAutoRemoveWhenDone defaults to false when not configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getAutoRemoveWhenDone(config)).toBe(false);
});

test('getAutoRemoveWhenDone returns true when configured true', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.auto_remove_when_done = true;
	expect(getAutoRemoveWhenDone(config)).toBe(true);
});

test('getAutoRemoveWhenDone returns false when configured false', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.auto_remove_when_done = false;
	expect(getAutoRemoveWhenDone(config)).toBe(false);
});

// ============================================================================
// getCompanionCommand Tests
// ============================================================================

test('companion_splits: a matched profile replaces the top-level list, and split defaults to down', () => {
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
	expect(getCompanionSplits(config, 'fix backend timeout')).toStrictEqual([
		{name: 'api', command: 'make run', size: 40, split: 'down'},
	]);
	expect(getCompanionSplits(config, 'web tweak')).toStrictEqual([
		{name: 'tests', command: 'bun test --watch', split: 'right', size: '30%'},
	]);
	expect(getCompanionSplits(createConfig({}, undefined))).toStrictEqual([]);
});

test('getCompanionCommand defaults to gitui when nothing is configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getCompanionCommand(config)).toBe(DEFAULT_COMPANION_COMMAND);
	expect(getCompanionCommand(config).includes('gitui')).toBe(true);
});

test('getCompanionCommand returns the top-level command when set', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.companion_command = 'lazygit';
	expect(getCompanionCommand(config)).toBe('lazygit');
});

test('getCompanionCommand preserves an explicit empty top-level command', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.companion_command = '';
	expect(getCompanionCommand(config)).toBe('');
});

test('getCompanionCommand prefers a matched profile override over top-level', () => {
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
	expect(getCompanionCommand(config, 'fix backend timeout')).toBe('make run');
});

test('getCompanionCommand falls back to top-level when the matched profile has no override', () => {
	const config = createConfig(
		{backend: createProfile(['backend'], 'Backend')},
		'backend',
	);
	config.companion_command = 'lazygit';
	expect(getCompanionCommand(config, 'fix backend timeout')).toBe('lazygit');
});

test('getCompanionCommand falls back to default when neither profile nor top-level set', () => {
	const config = createConfig(
		{backend: createProfile(['backend'], 'Backend')},
		'backend',
	);
	expect(getCompanionCommand(config, 'fix backend timeout')).toBe(
		DEFAULT_COMPANION_COMMAND,
	);
});

test('getCompanionCommand uses top-level when the title matches no profile', () => {
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
	expect(getCompanionCommand(config, 'unrelated task')).toBe('gitui');
});

// ============================================================================
// ide_command Validation Tests
// ============================================================================

// eslint-disable-next-line no-template-curly-in-string -- a shell template, expanded by bash, not JS
const IDEA_IDE_COMMAND = 'idea "${WORKTREE_PATH}"';

// ============================================================================
// getIdeCommand Tests
// ============================================================================

test('getIdeCommand defaults to Cursor when nothing is configured', () => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	expect(getIdeCommand(config)).toBe(DEFAULT_IDE_COMMAND);
	expect(getIdeCommand(config).includes('cursor')).toBe(true);
});

test('getIdeCommand returns the top-level command when set', () => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = CODE_IDE_COMMAND;
	expect(getIdeCommand(config)).toBe(CODE_IDE_COMMAND);
});

test('getIdeCommand prefers the named profile override over top-level', () => {
	const config = createConfig({
		backend: {
			...createProfile(['backend'], 'Backend'),
			ide_command: IDEA_IDE_COMMAND,
		},
	});
	config.ide_command = CODE_IDE_COMMAND;
	expect(getIdeCommand(config, 'backend')).toBe(IDEA_IDE_COMMAND);
});

test('getIdeCommand falls back to top-level when the named profile has no override', () => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = CODE_IDE_COMMAND;
	expect(getIdeCommand(config, 'backend')).toBe(CODE_IDE_COMMAND);
});

test('getIdeCommand falls back to top-level for a profile name not in config', () => {
	// A stale profile name persisted in space-state must not crash or resolve to
	// some other profile's editor.
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = CODE_IDE_COMMAND;
	expect(getIdeCommand(config, 'deleted_profile')).toBe(CODE_IDE_COMMAND);
});

test('getIdeCommand preserves an explicit empty top-level command', () => {
	const config = createConfig({backend: createProfile(['backend'], 'Backend')});
	config.ide_command = '';
	expect(getIdeCommand(config)).toBe('');
});

test('getIdeCommand preserves an explicit empty profile command over a set top-level', () => {
	const config = createConfig({
		backend: {...createProfile(['backend'], 'Backend'), ide_command: ''},
	});
	config.ide_command = CODE_IDE_COMMAND;
	expect(getIdeCommand(config, 'backend')).toBe('');
});

// ============================================================================
// matchProfileByProject Tests
// ============================================================================

test('matchProfileByProject matches exact project name', () => {
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
	expect(match).toBeTruthy();
	expect(match!.name).toBe('hive');
	expect(match!.profile.display_name).toBe('King Bee');
});

test('matchProfileByProject is case-insensitive', () => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
		},
	});
	const match = matchProfileByProject(config, 'the hive');
	expect(match).toBeTruthy();
	expect(match!.name).toBe('hive');
});

test('matchProfileByProject returns null when no match', () => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
		},
	});
	const match = matchProfileByProject(config, 'Unknown Project');
	expect(match).toBe(null);
});

test('matchProfileByProject returns null for empty project name', () => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
		},
	});
	expect(matchProfileByProject(config, '')).toBe(null);
});

// STA-1649: Jira issues carry a project key ("KAN") alongside the display
// name ("Pappardelle Testing"); tracker_projects entries may be either.

test('matchProfileByProject matches the Jira project key via the optional projectKey arg', () => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	const match = matchProfileByProject(config, 'Pappardelle Testing', 'KAN');
	expect(match).toBeTruthy();
	expect(match!.name).toBe('testing');
});

test('matchProfileByProject key matching is case-insensitive', () => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['kan'],
		},
	});
	const match = matchProfileByProject(config, 'Pappardelle Testing', 'KAN');
	expect(match).toBeTruthy();
	expect(match!.name).toBe('testing');
});

test('matchProfileByProject matches by key even when the project name is empty', () => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	const match = matchProfileByProject(config, '', 'KAN');
	expect(match).toBeTruthy();
	expect(match!.name).toBe('testing');
});

test('matchProfileByProject without a projectKey never matches key-style entries (regression pin)', () => {
	// A config listing only the Jira key must not match when callers pass just
	// a name — the Linear path (name-only) behaves exactly as before STA-1649.
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	expect(matchProfileByProject(config, 'Pappardelle Testing')).toBe(null);
});

test('matchProfileByProject returns null when neither name nor key matches', () => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['Some Other Project'],
		},
	});
	expect(matchProfileByProject(config, 'Pappardelle Testing', 'KAN')).toBe(
		null,
	);
});

test('matchProfileByProject returns null when both name and key are empty', () => {
	const config = createConfig({
		testing: {
			display_name: 'Pappardelle Testing',
			keywords: ['testing'],
			tracker_projects: ['KAN'],
		},
	});
	expect(matchProfileByProject(config, '', '')).toBe(null);
	expect(matchProfileByProject(config, '')).toBe(null);
});

test('matchProfileByProject returns null when no profiles have tracker_projects', () => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
		},
	});
	const match = matchProfileByProject(config, 'The Hive');
	expect(match).toBe(null);
});

test('matchProfileByProject matches second tracker_projects entry', () => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive', 'The Hive Quality'],
		},
	});
	const match = matchProfileByProject(config, 'The Hive Quality');
	expect(match).toBeTruthy();
	expect(match!.name).toBe('hive');
});

test('matchProfileByProject returns first matching profile when multiple match', () => {
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
	expect(match).toBeTruthy();
	expect(match!.name).toBe('first');
});

test('matchProfileByProject handles mixed case project name in config', () => {
	const config = createConfig({
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['THE HIVE QUALITY'],
		},
	});
	const match = matchProfileByProject(config, 'The Hive Quality');
	expect(match).toBeTruthy();
	expect(match!.name).toBe('hive');
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

test('getProfileDefaultProject returns first tracker_projects entry', () => {
	const profile: Profile = {
		display_name: 'King Bee',
		keywords: ['bee'],
		tracker_projects: ['The Hive Quality', 'Wordle'],
	};
	expect(getProfileDefaultProject(profile)).toBe('The Hive Quality');
});

test('getProfileDefaultProject returns sole tracker_projects entry', () => {
	const profile: Profile = {
		display_name: 'Pappardelle',
		keywords: ['pappardelle'],
		tracker_projects: ['Pappardelle Quality'],
	};
	expect(getProfileDefaultProject(profile)).toBe('Pappardelle Quality');
});

test('getProfileDefaultProject returns undefined when tracker_projects omitted (off-by-default)', () => {
	const profile: Profile = {
		display_name: 'Personal',
		keywords: ['personal'],
	};
	expect(getProfileDefaultProject(profile)).toBe(undefined);
});

test('getProfileDefaultProject returns undefined for empty tracker_projects (off-by-default)', () => {
	const profile: Profile = {
		display_name: 'Test',
		keywords: ['t'],
		tracker_projects: [],
	};
	expect(getProfileDefaultProject(profile)).toBe(undefined);
});

test("getProfileDefaultProject preserves exact casing — UUID resolution is the bash side's responsibility", () => {
	const profile: Profile = {
		display_name: 'Mixed',
		keywords: ['m'],
		tracker_projects: ['  Stardust Jams MVP  '],
	};
	// Whatever the user wrote is what we return — provider-helpers.sh's jq filter
	// is what decides whether trimming/case-folding happens at resolution time.
	expect(getProfileDefaultProject(profile)).toBe('  Stardust Jams MVP  ');
});

// ============================================================================
// matchProfilesByKeyPrefix
//
// Which profiles could plausibly own an issue whose key carries a given
// prefix. Explicit claims (own team_prefix, or a tracker_projects entry
// spelling a Jira project key) outrank the profiles that merely inherit the
// global team_prefix.
// ============================================================================

test('matchProfilesByKeyPrefix matches a profile own team_prefix', () => {
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
	expect(
		matchProfilesByKeyPrefix(config, 'TRT').map(m => m.name),
	).toStrictEqual(['trotbooks']);
});

test('matchProfilesByKeyPrefix matches case-insensitively', () => {
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
	expect(
		matchProfilesByKeyPrefix(config, 'per').map(m => m.name),
	).toStrictEqual(['personal']);
});

test('matchProfilesByKeyPrefix matches a tracker_projects entry as a project key', () => {
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
	expect(matches.map(m => m.name)).toStrictEqual(['personal']);
	expect(matches[0]!.explicit).toBe(true);
});

test('matchProfilesByKeyPrefix matches an issue_watchlist key_prefixes entry', () => {
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
	expect(matches.map(m => m.name)).toStrictEqual(['personal']);
	expect(matches[0]!.explicit).toBe(true);
});

test('matchProfilesByKeyPrefix treats prefix-less profiles as inheriting the global prefix', () => {
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
	expect(matches.map(m => m.name)).toStrictEqual(['personal']);
	expect(matches[0]!.explicit).toBe(false);
});

test('matchProfilesByKeyPrefix ranks explicit claims ahead of inherited ones', () => {
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
	expect(
		matchProfilesByKeyPrefix(config, 'STA').map(m => m.name),
	).toStrictEqual(['trotbooks', 'personal']);
});

test('matchProfilesByKeyPrefix returns nothing for an unclaimed prefix', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
		'STA',
	);
	expect(matchProfilesByKeyPrefix(config, 'ZZZ')).toStrictEqual([]);
	expect(matchProfilesByKeyPrefix(config, '  ')).toStrictEqual([]);
});

test('matchProfilesByKeyPrefix falls back to the STA default when no team_prefix is set', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	expect(
		matchProfilesByKeyPrefix(config, 'STA').map(m => m.name),
	).toStrictEqual(['personal']);
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

test('determineProfileForInput returns null for empty / whitespace input', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	expect(determineProfileForInput(config, '')).toBe(null);
	expect(determineProfileForInput(config, '   \t ')).toBe(null);
});

test('determineProfileForInput defers profile selection for issue keys', () => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'STA-123');
	expect(info).toBeTruthy();
	expect(info!.kind).toBe('deferred');
	if (info!.kind === 'deferred') {
		expect(info.displayName).toBe(DEFERRED_PROFILE_DISPLAY_NAME);
	}
});

test('determineProfileForInput defers profile selection for beads IDs', () => {
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
	expect(info?.kind).toBe('deferred');
});

test('determineProfileForInput keyword-matches a beads-shaped phrase', () => {
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
	expect(info?.kind).toBe('resolved');
});

test('determineProfileForInput marks a beads ID pickable even when nothing claims its prefix', () => {
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
	expect(matchProfilesByInputKeyPrefix(config, 'pap-a1b2')).toStrictEqual([]);
	const info = determineProfileForInput(config, 'pap-a1b2');
	expect(info!.kind).toBe('deferred');
	if (info!.kind === 'deferred') expect(info.canPick).toBe(true);
});

test('matchProfilesByInputKeyPrefix reads the prefix of a beads ID', () => {
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
	expect(
		matchProfilesByInputKeyPrefix(config, 'vendor-sdk-a1b2').map(m => m.name),
	).toStrictEqual(['vendor']);
});

test('determineProfileForInput does not defer beads IDs under other trackers', () => {
	// Regression pin: the beads branch must be gated on the configured provider.
	const config = {
		...createConfig(
			{personal: createProfile(['personal'], 'Personal')},
			'personal',
		),
		team_prefix: 'pap',
	};
	expect(determineProfileForInput(config, 'pap-a1b2')?.kind).toBe('resolved');
});

// ============================================================================
// exampleIssueKeys
// ============================================================================

test('exampleIssueKeys uses the team prefix for numbered trackers', () => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'qa',
		profiles: {},
	};
	expect(exampleIssueKeys(config)).toStrictEqual(['QA-123', '123']);
});

test('exampleIssueKeys shows a beads id with the beads prefix', () => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'qa',
		issue_tracker: {provider: 'beads'},
		profiles: {},
	};
	expect(exampleIssueKeys(config, () => 'pap')).toStrictEqual(['pap-a1b2']);
});

// ============================================================================
// getBeadsPrefixes
// ============================================================================

test('getBeadsPrefixes collects the team prefix and tracker_projects', () => {
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
	expect(getBeadsPrefixes(config).sort()).toStrictEqual([
		'alt',
		'myproj',
		'pap',
		'vendor-sdk',
	]);
});

test('getBeadsPrefixes lowercases and dedupes', () => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'PAP',
		profiles: {a: {display_name: 'A', tracker_projects: ['pap', ' Pap ']}},
	};
	expect(getBeadsPrefixes(config)).toStrictEqual(['pap']);
});

test('getBeadsPrefixes is empty when nothing is configured', () => {
	expect(getBeadsPrefixes({version: 1, profiles: {}})).toStrictEqual([]);
});

test('getBeadsPrefixes includes the database issue-prefix', () => {
	// bd mints IDs under .beads/config.yaml's issue-prefix, which need not match
	// team_prefix — a repo migrating off Linear keeps the old team prefix while
	// beads names issues after the repo directory. Missing it made those IDs read
	// as prose and file a duplicate issue.
	expect(
		getBeadsPrefixes({version: 1, profiles: {}, team_prefix: 'STA'}, 'myrepo'),
	).toStrictEqual(['myrepo', 'sta']);
});

test('getBeadsPrefixes lowercases and dedupes the database issue-prefix', () => {
	expect(
		getBeadsPrefixes({version: 1, profiles: {}, team_prefix: 'pap'}, 'PAP'),
	).toStrictEqual(['pap']);
});

test('readBeadsIssuePrefix reads issue-prefix from .beads/config.yaml', () => {
	const dir = tempDir('beads-prefix-');
	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(
		path.join(dir, '.beads', 'config.yaml'),
		'issue-prefix: vendor-sdk\n',
	);
	expect(readBeadsIssuePrefix(dir)).toBe('vendor-sdk');
});

test('readBeadsIssuePrefix is undefined when the file or key is absent', () => {
	const noDatabasePrefix = () => undefined;
	const dir = tempDir('beads-prefix-');
	expect(readBeadsIssuePrefix(dir, noDatabasePrefix)).toBe(undefined);

	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(path.join(dir, '.beads', 'config.yaml'), 'other: value\n');
	clearBeadsIssuePrefixCache();
	expect(readBeadsIssuePrefix(dir, noDatabasePrefix)).toBe(undefined);
});

test('readBeadsIssuePrefix falls back to the bd database without a config.yaml prefix', () => {
	const dir = tempDir('beads-prefix-');
	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(
		path.join(dir, '.beads', 'config.yaml'),
		'# issue-prefix: ""\n',
	);
	expect(
		readBeadsIssuePrefix(dir, root => (root === dir ? 'qa' : undefined)),
	).toBe('qa');
});

test('parseBdIssuePrefix reads plain and enveloped bd config output', () => {
	expect(parseBdIssuePrefix('{"key":"issue_prefix","value":"QA"}\n')).toBe(
		'QA',
	);
	expect(
		parseBdIssuePrefix(
			'{"schema_version":1,"data":{"key":"issue_prefix","value":"QA"}}\n',
		),
	).toBe('QA');
	expect(parseBdIssuePrefix('{"key":"issue_prefix","value":"  "}')).toBe(
		undefined,
	);
});

test('readBeadsIssuePrefix asks bd only in a beads repo', () => {
	const dir = tempDir('beads-prefix-');
	expect(readBeadsIssuePrefix(dir, () => 'qa')).toBe(undefined);
});

// determineProfileForInput runs on every keystroke in the new-session prompt,
// so this has to stay a cache hit — an uncached read puts a blocking
// readFileSync and a YAML parse on the TUI's render path per character.
test('readBeadsIssuePrefix parses .beads/config.yaml at most once per root', () => {
	const dir = tempDir('beads-prefix-');
	fs.mkdirSync(path.join(dir, '.beads'));
	const configPath = path.join(dir, '.beads', 'config.yaml');
	fs.writeFileSync(configPath, 'issue-prefix: first\n');

	clearBeadsIssuePrefixCache();
	expect(readBeadsIssuePrefix(dir)).toBe('first');

	// Rewriting on disk must not be observable: a second call that re-reads
	// would return 'second' and fail here.
	fs.writeFileSync(configPath, 'issue-prefix: second\n');
	expect(readBeadsIssuePrefix(dir)).toBe('first');

	// The cache is keyed per root, so a different repo still resolves on its own.
	const other = tempDir('beads-prefix-');
	fs.mkdirSync(path.join(other, '.beads'));
	fs.writeFileSync(
		path.join(other, '.beads', 'config.yaml'),
		'issue-prefix: elsewhere\n',
	);
	expect(readBeadsIssuePrefix(other)).toBe('elsewhere');
	expect(readBeadsIssuePrefix(dir)).toBe('first');
});

// A repo with no beads config is the case that would otherwise re-stat a
// missing file on every keystroke, so the negative result has to cache too.
test('readBeadsIssuePrefix caches a missing .beads/config.yaml', () => {
	const dir = tempDir('beads-prefix-');

	clearBeadsIssuePrefixCache();
	expect(readBeadsIssuePrefix(dir)).toBe(undefined);

	fs.mkdirSync(path.join(dir, '.beads'));
	fs.writeFileSync(
		path.join(dir, '.beads', 'config.yaml'),
		'issue-prefix: x\n',
	);
	expect(readBeadsIssuePrefix(dir)).toBe(undefined);
});

test('determineProfileForInput defers a lowercase issue key like an uppercase one', () => {
	// A lowercase key reaches the tracker as the same issue, so it has to reach
	// the same profile decision — otherwise the preview and the option list the
	// picker renders disagree about what Enter is going to do.
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	expect(determineProfileForInput(config, 'sta-123')!.kind).toBe('deferred');
	expect(
		determineProfileForInput(
			config,
			'https://linear.app/acme/issue/sta-123/slug',
		)!.kind,
	).toBe('deferred');
});

test('determineProfileForInput marks a claimed key prefix as pickable', () => {
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
	expect(info!.kind).toBe('deferred');
	if (info!.kind === 'deferred') expect(info.canPick).toBe(true);
});

test('determineProfileForInput leaves an unclaimed key prefix unpickable', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, 'ZZZ-123');
	expect(info!.kind).toBe('deferred');
	if (info!.kind === 'deferred') expect(info.canPick).toBe(false);
});

test('determineProfileForInput leaves a bare number unpickable', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, '42');
	expect(info!.kind).toBe('deferred');
	if (info!.kind === 'deferred') expect(info.canPick).toBe(false);
});

test('determineProfileForInput defers profile selection for bare issue numbers', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, '42');
	expect(info).toBeTruthy();
	expect(info!.kind).toBe('deferred');
	if (info!.kind === 'deferred') {
		expect(info.displayName).toBe(DEFERRED_PROFILE_DISPLAY_NAME);
	}
});

test('determineProfileForInput defers profile selection for Linear URLs', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(
		config,
		'https://linear.app/stardust-labs/issue/STA-123/something',
	);
	expect(info).toBeTruthy();
	expect(info!.kind).toBe('deferred');
	if (info!.kind === 'deferred') {
		expect(info.displayName).toBe(DEFERRED_PROFILE_DISPLAY_NAME);
	}
});

test('determineProfileForInput returns default profile when no keyword matches', () => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'random description nothing');
	expect(info).toBeTruthy();
	expect(info!.kind).toBe('resolved');
	if (info!.kind === 'resolved') {
		expect(info.name).toBe('personal');
		expect(info.isDefault).toBe(true);
		expect(info.matchedKeywords).toStrictEqual([]);
	}
});

test('determineProfileForInput picks the single matching profile', () => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'upload to trotbooks');
	expect(info).toBeTruthy();
	expect(info!.kind).toBe('resolved');
	if (info!.kind === 'resolved') {
		expect(info.name).toBe('trotbooks');
		expect(info.isDefault).toBe(false);
	}
});

test('determineProfileForInput picks highest-scoring profile on multi-match (STA-856 regression)', () => {
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
	expect(info).toBeTruthy();
	expect(info!.kind).toBe('resolved');
	if (info!.kind === 'resolved') {
		expect(info.name).toBe('trotbooks');
		expect(info.isDefault).toBe(false);
		// Should surface the keywords that tipped the scoring so the caller can show them.
		expect(info.matchedKeywords.length >= 2).toBe(true);
	}
});

test('determineProfileForInput honors enforced (!) keywords', () => {
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
	expect(info).toBeTruthy();
	expect(info!.kind).toBe('resolved');
	if (info!.kind === 'resolved') {
		expect(info.name).toBe('personal');
		expect(info.enforced).toBe(true);
	}
});

// ============================================================================
// determineProfileForInput — profile emoji (STA-1837)
//
// The typing-stage hint in PromptDialog shows the same glyph the picker will
// show one keystroke later, so the emoji has to ride along with the selection
// rather than be re-resolved by the component.
// ============================================================================

test('determineProfileForInput carries the matched profile emoji', () => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: {...createProfile(['trotbooks'], 'TrotBooks'), emoji: '🐎'},
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'fix trotbooks invoices');
	expect(info!.kind).toBe('resolved');
	if (info!.kind === 'resolved') {
		expect(info.emoji).toBe('🐎');
	}
});

test('determineProfileForInput reserves a blank emoji slot when siblings have one', () => {
	const config = createConfig(
		{
			personal: createProfile(['personal'], 'Personal'),
			trotbooks: {...createProfile(['trotbooks'], 'TrotBooks'), emoji: '🐎'},
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'personal notes');
	if (info!.kind === 'resolved') {
		expect(info.emoji).toBe('');
	}
});

test('determineProfileForInput leaves emoji undefined when nothing configures one', () => {
	const config = createConfig(
		{personal: createProfile(['personal'], 'Personal')},
		'personal',
	);
	const info = determineProfileForInput(config, 'personal notes');
	if (info!.kind === 'resolved') {
		expect(info.emoji).toBe(undefined);
	}
});

test('determineProfileForInput emoji survives the default-profile fallback', () => {
	const config = createConfig(
		{
			personal: {...createProfile(['personal'], 'Personal'), emoji: '🎸'},
			trotbooks: createProfile(['trotbooks'], 'TrotBooks'),
		},
		'personal',
	);
	const info = determineProfileForInput(config, 'something unmatched');
	if (info!.kind === 'resolved') {
		expect(info.isDefault).toBe(true);
		expect(info.emoji).toBe('🎸');
	}
});

// ============================================================================
// getStateColors Tests
// ============================================================================

test('getStateColors returns undefined when not configured', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	expect(getStateColors(config)).toBe(undefined);
});

test('getStateColors returns undefined for a null config', () => {
	expect(getStateColors(null)).toBe(undefined);
});

test('getStateColors returns the configured map', () => {
	const config = createConfig(
		{'test-profile': createProfile(['test'], 'Test')},
		'test-profile',
	);
	config.state_colors = {'In Review': 'cyan'};
	expect(getStateColors(config)).toStrictEqual({'In Review': 'cyan'});
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

test('only beads defaults to two_line', () => {
	expect(getListLayout(listLayoutConfig('beads'))).toBe('two_line');
	expect(getListLayout(listLayoutConfig('linear'))).toBe('single_line');
	expect(getListLayout(listLayoutConfig('jira'))).toBe('single_line');
	expect(getListLayout(listLayoutConfig())).toBe('single_line');
	expect(getListLayout(null)).toBe('single_line');
});

test('an explicit list_view.layout overrides the tracker default either way', () => {
	expect(getListLayout(listLayoutConfig('beads', 'single_line'))).toBe(
		'single_line',
	);
	expect(getListLayout(listLayoutConfig('linear', 'two_line'))).toBe(
		'two_line',
	);
});

test('an empty list_view block leaves the tracker default standing', () => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.issue_tracker = {provider: 'beads'};
	config.list_view = {};
	expect(getListLayout(config)).toBe('two_line');
});

test('getPaneWidths maps layout keys onto the three panes', () => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.layout = {rail_width: '10%', claude_width: '45%', companion_width: 70};
	expect(getPaneWidths(config)).toStrictEqual({
		rail: '10%',
		claude: '45%',
		companion: 70,
	});
	expect(getPaneWidths(null)).toStrictEqual({
		rail: undefined,
		claude: undefined,
		companion: undefined,
	});
});

// ============================================================================
// issue_watchlist max_workspaces Validation Tests (STE-25)
// ============================================================================

test('getResolvedWatchlists keeps max_workspaces on an auto-scoped profile watchlist', () => {
	const chaz: Profile = {
		display_name: 'Charlie Personal',
		team_prefix: 'CHAZ',
		issue_watchlist: {statuses: ['For Pappardelle'], max_workspaces: 3},
	};
	const resolved = getResolvedWatchlists(createConfig({chaz}, 'chaz'));
	expect(resolved[0]!.watchlist.key_prefixes).toStrictEqual(['CHAZ']);
	expect(resolved[0]!.watchlist.max_workspaces).toBe(3);
});

// ============================================================================
// initialization_command — rename + deprecated fallback
// ============================================================================

test('getInitializationCommand prefers the new top-level key', () => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.initialization_command = '/new';
	expect(getInitializationCommand(config)).toBe('/new');
});

test('getInitializationCommand falls back to the deprecated claude spelling', () => {
	const config = createConfig({test: createProfile(['test'], 'Test')});
	config.claude = {initialization_command: '/old'};
	expect(getInitializationCommand(config)).toBe('/old');
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

test('getAgentProfile defaults to the built-in claude agent profile', () => {
	const agentProfile = getAgentProfile(agentProfileTestConfig());
	expect(agentProfile).toStrictEqual({
		name: 'claude',
		command: 'claude',
		args: '',
		resumeArgs: '--resume {session_id}',
		isClaude: true,
		model: '',
		effort: '',
		mode: '',
		modelArgs: '--model {model}',
		effortArgs: '--effort {effort}',
		modeArgs: undefined,
		promptArgs: undefined,
		extraArgs: [],
		skillPrefix: '/',
		rulesArgs: [],
		env: {},
	});
});

test('getAgentProfile trims the trailing newline of a YAML block scalar', () => {
	const config = agentProfileTestConfig({
		agent_profile: 'codex',
		agent_profiles: {
			codex: {command: 'codex\n', args: '--yolo\n', model: 'gpt-5.5\n'},
		},
	});
	expect(getAgentProfile(config)).toMatchObject({
		command: 'codex',
		args: '--yolo',
	});
	expect(getAgentProfile(config).model).toBe('gpt-5.5');
});

test('listAgentProfiles labels each agent profile with its config files', () => {
	expect(
		listAgentProfiles(
			agentProfileTestConfig({
				agent_profiles: {codex: {command: 'codex'}, aider: {command: 'aider'}},
			}),
			{codex: ['.pappardelle.local.yml', '~/.pappardelle/.pappardelle.yml']},
		),
	).toStrictEqual([
		{name: 'claude', source: 'built-in'},
		{
			name: 'codex',
			source: '.pappardelle.local.yml + ~/.pappardelle/.pappardelle.yml',
		},
		{name: 'aider', source: 'built-in'},
	]);
});

test('checkAgentProfile knows the built-in claude and every configured agent profile, and lists them all for any other name', () => {
	const config = agentProfileTestConfig({
		agent_profiles: {'antigravity-neon:high': {command: 'agy'}},
	});
	expect(checkAgentProfile(config, 'claude')).toStrictEqual({kind: 'known'});
	expect(checkAgentProfile(config, 'antigravity-neon:high')).toStrictEqual({
		kind: 'known',
	});
	expect(checkAgentProfile(config, 'antigravity-neon')).toStrictEqual({
		kind: 'unknown',
		names: ['claude', 'antigravity-neon:high'],
	});
});

test('listAgentProfiles keeps a shadowing claude where it was declared', () => {
	expect(
		listAgentProfiles(
			agentProfileTestConfig({
				agent_profiles: {
					codex: {command: 'codex'},
					claude: {command: '/opt/bin/claude'},
				},
			}),
			{codex: ['.pappardelle.yml'], claude: ['.pappardelle.yml']},
		),
	).toStrictEqual([
		{name: 'codex', source: '.pappardelle.yml'},
		{name: 'claude', source: '.pappardelle.yml'},
	]);
});

test('loadAgentProfileSources names every layer that defines an agent profile, the winning one first', () => {
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
		expect(
			loadAgentProfileSources({
				homeConfigDir: path.join(dir, 'home'),
				projectDir: path.join(dir, 'project'),
			}),
		).toStrictEqual({
			codex: ['.pappardelle.local.yml', '~/.pappardelle/.pappardelle.yml'],
			opus: ['.pappardelle.yml'],
		});
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

test('getAgentProfile resolves a top-level agent_profile reference', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {
				codex: {command: 'codex', args: '--yolo', resume_args: 'resume --last'},
			},
			agent_profile: 'codex',
		}),
	);
	expect(agentProfile.command).toBe('codex');
	expect(agentProfile.args).toBe('--yolo');
	expect(agentProfile.resumeArgs).toBe('resume --last');
	expect(agentProfile.isClaude).toBe(false);
});

test('getAgentProfile resolves a per-profile reference via issue title', () => {
	const config = agentProfileTestConfig({
		agent_profiles: {codex: {command: 'codex'}},
	});
	config.profiles['codexy']!.agent_profile = 'codex';
	expect(getAgentProfile(config, 'codexwork thing').command).toBe('codex');
	expect(getAgentProfile(config, 'plainwork thing').command).toBe('claude');
	expect(getAgentProfile(config).command).toBe('claude');
});

test('getAgentProfile: profile agent_profile "" clears an inherited reference back to claude', () => {
	const config = agentProfileTestConfig({
		agent_profiles: {codex: {command: 'codex'}},
		agent_profile: 'codex',
	});
	config.profiles['plain']!.agent_profile = '';
	expect(getAgentProfile(config, 'plainwork thing').command).toBe('claude');
	expect(getAgentProfile(config, 'codexwork thing').command).toBe('codex');
});

test('getAgentProfile: shadowed agent_profiles.claude keeps claude gating', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {claude: {command: 'claude', args: '--verbose'}},
		}),
	);
	expect(agentProfile.args).toBe('--verbose');
	expect(agentProfile.isClaude).toBe(true);
	expect(agentProfile.resumeArgs).toBe('--resume {session_id}');
});

test('getAgentProfile: an agent without built-in defaults or resume_args gets no resume', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {aider: {command: 'aider'}},
			agent_profile: 'aider',
		}),
	);
	expect(agentProfile.resumeArgs).toBe(undefined);
});

test('getAgentProfile: is_claude true forces claude treatment for a wrapper', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {local: {command: 'claude-local', is_claude: true}},
			agent_profile: 'local',
		}),
	);
	expect(agentProfile.isClaude).toBe(true);
	expect(agentProfile.resumeArgs).toBe('--resume {session_id}');
});

test('getAgentProfile: is_claude false suppresses claude treatment', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {sneaky: {command: 'claude', is_claude: false}},
			agent_profile: 'sneaky',
		}),
	);
	expect(agentProfile.isClaude).toBe(false);
	expect(agentProfile.resumeArgs).toBe(undefined);
});

test('getAgentProfile: empty resume_args means no resume attempt', () => {
	// '' must behave like the bash resolvers' empty value (launch directly),
	// not slip through into a malformed `base  || … || base` chain.
	const codex = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {codex: {command: 'codex', resume_args: ''}},
			agent_profile: 'codex',
		}),
	);
	expect(codex.resumeArgs).toBe(undefined);

	// Even for claude: an explicit '' opts out of the resume default.
	const claude = getAgentProfile(
		agentProfileTestConfig({
			agent_profiles: {claude: {command: 'claude', resume_args: ''}},
		}),
	);
	expect(claude.resumeArgs).toBe(undefined);
});

test('getAgentProfile: persisted profile name wins over title matching', () => {
	const config = agentProfileTestConfig({
		agent_profiles: {codex: {command: 'codex'}},
	});
	config.profiles['codexy']!.agent_profile = 'codex';
	// Title has no profile keyword — the persisted profile still selects codex.
	expect(getAgentProfile(config, 'Fix parser bug', 'codexy').command).toBe(
		'codex',
	);
	// Persisted name beats a conflicting keyword match.
	expect(getAgentProfile(config, 'plainwork thing', 'codexy').command).toBe(
		'codex',
	);
	// A stale name that no longer exists falls back to title matching.
	expect(getAgentProfile(config, 'codexwork thing', 'deleted').command).toBe(
		'codex',
	);
	expect(getAgentProfile(config, 'Fix parser bug', 'deleted').command).toBe(
		'claude',
	);
});

test('launch fields and companion resolve via the persisted profile name', () => {
	const config = agentProfileTestConfig();
	config.profiles['codexy']!.claude = {model: 'sonnet'};
	config.profiles['codexy']!.companion_command = 'lazygit';
	expect(getAgentProfile(config, 'Fix parser bug', 'codexy').model).toBe(
		'sonnet',
	);
	expect(getCompanionCommand(config, 'Fix parser bug', 'codexy')).toBe(
		'lazygit',
	);
	// Stale persisted name → title match → top-level defaults.
	expect(getAgentProfile(config, 'Fix parser bug', 'deleted').model).toBe('');
});

// ============================================================================
// Agent profiles — model and effort
// ============================================================================

test('getAgentProfile gives codex its built-in model and effort flags', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profile: 'codex',
			agent_profiles: {codex: {command: '/opt/bin/codex'}},
		}),
	);
	expect(agentProfile.modelArgs).toBe('-m {model}');
	expect(agentProfile.effortArgs).toBe('-c model_reasoning_effort={effort}');
});

test('codex runs skills with $ and other agents with /, unless the agent profile says otherwise', () => {
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
	expect(skillPrefix('codex')).toBe('$');
	expect(skillPrefix('claude')).toBe('/');
	expect(skillPrefix('aider')).toBe('/');
	expect(skillPrefix('wrapped')).toBe('!');
});

test('getAgentProfile prefers configured flag templates over the built-in ones', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profile: 'codex',
			agent_profiles: {
				codex: {command: 'codex', model_args: '--model={model}'},
			},
		}),
	);
	expect(agentProfile.modelArgs).toBe('--model={model}');
	expect(agentProfile.effortArgs).toBe('-c model_reasoning_effort={effort}');
});

test('getAgentProfile gives other CLIs no model or effort flags', () => {
	const agentProfile = getAgentProfile(
		agentProfileTestConfig({
			agent_profile: 'aider',
			agent_profiles: {aider: {command: 'aider'}},
		}),
	);
	expect(agentProfile.modelArgs).toBe(undefined);
	expect(agentProfile.effortArgs).toBe(undefined);
});

test("an agent profile's own model and effort beat the deprecated claude block", () => {
	const config = agentProfileTestConfig({
		claude: {model: 'sonnet', effort: 'low'},
		agent_profile: 'opus',
		agent_profiles: {opus: {command: 'claude', model: 'opus', effort: 'max'}},
	});
	expect(getAgentProfile(config).model).toBe('opus');
	expect(getAgentProfile(config).effort).toBe('max');
});

test('a claude agent profile without its own model falls back to the claude block', () => {
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
	expect(getAgentProfile(config).model).toBe('sonnet');
	expect(getAgentProfile(config, 'codexwork').model).toBe('haiku');
	expect(getAgentProfile(config).effort).toBe('high');
});

test('a non-claude agent profile never reads the claude block', () => {
	const config = agentProfileTestConfig({
		claude: {model: 'sonnet', effort: 'low'},
		agent_profile: 'codex',
		agent_profiles: {codex: {command: 'codex'}},
	});
	expect(getAgentProfile(config).model).toBe('');
	expect(getAgentProfile(config).effort).toBe('');
});

test("an agent profile's empty model clears the claude block's", () => {
	const config = agentProfileTestConfig({
		claude: {model: 'sonnet'},
		agent_profile: 'plain-claude',
		agent_profiles: {'plain-claude': {command: 'claude', model: ''}},
	});
	expect(getAgentProfile(config).model).toBe('');
});

test('a config file with broken YAML is reported with the file and line', () => {
	const error = thrownBy(
		() =>
			parseConfigLayer(
				'.pappardelle.yml',
				'claude:\n  model: opus\n   extra: x\n',
			),
		ConfigValidationError,
	);
	expect(error!.errors[0]!).toMatch(
		/^\.pappardelle\.yml: .*at line \d+, column \d+/,
	);
});

test('YAML merge keys resolve in a config file', () => {
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
	expect((layer!['profiles'] as Record<string, unknown>)['api']).toStrictEqual({
		vcs_label: 'Backend',
		team_prefix: 'API',
	});
});

test('an unknown YAML tag in a config file is reported with the file and line', () => {
	const error = thrownBy(
		() => parseConfigLayer('.pappardelle.local.yml', 'a: 1\nemoji: !foo bar\n'),
		ConfigValidationError,
	);
	expect(error!.errors.length).toBe(1);
	expect(error!.errors[0]!).toMatch(
		/^\.pappardelle\.local\.yml: Unresolved tag: !foo at line 2, column \d+/,
	);
});

test('an undefined YAML alias in a config file is reported with the file', () => {
	const error = thrownBy(
		() => parseConfigLayer('.pappardelle.yml', 'emoji: *nope\n'),
		ConfigValidationError,
	);
	expect(error!.errors[0]!).toMatch(/^\.pappardelle\.yml: .*nope/);
});

// ============================================================================
// list_view.group_by / list_view.groups
// ============================================================================

test('grouping is off unless list_view.group_by is status', () => {
	const config = {version: 1, profiles: {}} as unknown as PappardelleConfig;
	expect(isRailGroupedByStatus(config)).toBe(false);
	config.list_view = {group_by: 'status'};
	expect(isRailGroupedByStatus(config)).toBe(true);
	expect(
		validateListView({group_by: 'priority'}).includes(
			'list_view.group_by: must be "status"',
		),
	).toBe(true);
});

test('getRailGroups falls back to the default groups', () => {
	expect(getRailGroups(null).map(group => group.name)).toStrictEqual([
		'In Progress',
		'In Review',
		'Done',
	]);
});

// ============================================================================
// sous_chef_key
// ============================================================================

test('getSousChefKey defaults to M-s, also when the config failed to load', () => {
	const config = {version: 1, profiles: {}} as unknown as PappardelleConfig;
	expect(getSousChefKey(config)).toBe('M-s');
	expect(getSousChefKey(null)).toBe('M-s');
});

test('getSousChefKey returns the configured key, and null when turned off', () => {
	const base = {version: 1, profiles: {}} as unknown as PappardelleConfig;
	expect(getSousChefKey({...base, sous_chef_key: 'M-j'})).toBe('M-j');
	expect(getSousChefKey({...base, sous_chef_key: false})).toBe(null);
});
