import test from 'ava';
import type {PappardelleConfig, Profile} from './config.ts';
import {
	matchProfiles,
	getTeamPrefix,
	getProfileTeamPrefix,
	getProfileVcsLabel,
	getInitializationCommand,
	getKeybindings,
	repoNameFromGitCommonDir,
	qualifyMainBranch,
	validateConfig,
	ConfigValidationError,
	RESERVED_KEYS,
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
	defaultProfile = 'default',
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

test('pappardelle should win even when profiles are ordered with stardust-jams first', t => {
	// This tests the tie-breaking issue - stardust-jams is first in the config
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
		pappardelle: createProfile(['pappardelle'], 'Pappardelle'),
	});

	const matches = matchProfiles(config, 'pappardelle tracking test');
	t.true(matches.length >= 1);
	// pappardelle should win because 'tracking' should NOT match 'track'
	t.is(matches[0]!.name, 'pappardelle');
});

// ============================================================================
// Substring Matching Tests (The Core Bug)
// ============================================================================

test('SHOULD NOT match "track" keyword when input has "tracking"', t => {
	// This is the core bug - substring matching is too loose
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'tracking the issue');
	t.is(matches.length, 0, 'tracking should NOT match track keyword');
});

test('SHOULD NOT match "record" keyword when input has "recording"', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['record'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'recording a video');
	t.is(matches.length, 0, 'recording should NOT match record keyword');
});

test('SHOULD NOT match "music" keyword when input has "mu"', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['music'], 'Stardust Jams'),
	});

	const matches = matchProfiles(config, 'mu test');
	t.is(matches.length, 0, 'mu should NOT match music keyword');
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
// Prefix Keyword Tests (keywords ending with a hyphen)
// ============================================================================

test('keyword ending with hyphen matches as prefix: "SHOP-" matches "SHOP-313"', t => {
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

test('prefix keyword does NOT match word without the hyphen suffix', t => {
	const config = createConfig({
		shop: createProfile(['SHOP-'], 'Shop'),
	});

	// "shop" alone should NOT match "SHOP-" prefix keyword
	const matches = matchProfiles(config, 'shop is broken');
	t.is(matches.length, 0, '"shop" should NOT match prefix keyword "SHOP-"');
});

test('regular keywords still use exact matching (not prefix)', t => {
	const config = createConfig({
		'stardust-jams': createProfile(['track'], 'Stardust Jams'),
	});

	// "tracking" should still NOT match exact keyword "track"
	const matches = matchProfiles(config, 'tracking the issue');
	t.is(matches.length, 0);
});

test('prefix keyword coexists with exact keywords in same profile', t => {
	const config = createConfig({
		shop: createProfile(['SHOP-', 'store'], 'Shop'),
	});

	const prefixMatch = matchProfiles(config, 'SHOP-42 is down');
	t.is(prefixMatch.length, 1);
	t.is(prefixMatch[0]!.name, 'shop');

	const exactMatch = matchProfiles(config, 'the store is closed');
	t.is(exactMatch.length, 1);
	t.is(exactMatch[0]!.name, 'shop');
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

test('validateConfig rejects keybinding with reserved key', t => {
	for (const reservedKey of RESERVED_KEYS) {
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

test('validateConfig rejects keybinding missing run', t => {
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
	t.truthy(error?.message.includes('run: required string field'));
});

test('validateConfig accepts uppercase versions of reserved keys', t => {
	// Uppercase letters like 'G', 'D', 'R' should be valid even though
	// their lowercase counterparts are reserved built-in shortcuts
	const uppercaseReserved = [...RESERVED_KEYS]
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
