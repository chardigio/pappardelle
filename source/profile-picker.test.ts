import test from 'ava';
import {
	buildProfileOptions,
	computePickerWindow,
	handleProfilePickerKey,
	resolvePromptSubmit,
	focusFrame,
	PICKER_MAX_VISIBLE,
} from './profile-picker.ts';
import {
	DEFERRED_PROFILE_DISPLAY_NAME,
	type PappardelleConfig,
} from './config.ts';

// ============================================================================
// Test helpers
// ============================================================================

function makeConfig(
	profiles: Record<
		string,
		{
			display_name: string;
			keywords?: string[];
			emoji?: string;
			team_prefix?: string;
			tracker_projects?: string[];
		}
	>,
	defaultProfile?: string,
	defaultEmoji?: string,
	teamPrefix?: string,
): PappardelleConfig {
	return {
		version: 1,
		default_profile: defaultProfile,
		default_emoji: defaultEmoji,
		team_prefix: teamPrefix,
		profiles,
	} as unknown as PappardelleConfig;
}

const CONFIG = makeConfig(
	{
		platform: {display_name: 'Platform', keywords: ['platform', 'sllib']},
		stardust: {display_name: 'Stardust Jams', keywords: ['stardust', 'jams']},
		trotbooks: {display_name: 'TrotBooks', keywords: ['trotbooks', 'trot']},
		hive: {display_name: 'The Hive', keywords: ['hive', 'bee']},
	},
	'platform',
);

// ============================================================================
// buildProfileOptions — ordering
// ============================================================================

test('buildProfileOptions puts the keyword-matched profile first', t => {
	const options = buildProfileOptions(CONFIG, 'fix the stardust map crash');
	t.is(options[0]!.name, 'stardust');
	t.deepEqual(options[0]!.matchedKeywords, ['stardust']);
	t.false(options[0]!.isDefault);
});

test('buildProfileOptions lists every profile exactly once', t => {
	const options = buildProfileOptions(CONFIG, 'fix the stardust map crash');
	t.is(options.length, 4);
	// Sorted with an explicit comparator because an option's name is nullable —
	// the profile-less row exists, just never on the keyword path.
	const names = options.map(o => o.name);
	names.sort((a, b) => String(a).localeCompare(String(b)));
	t.deepEqual(names, ['hive', 'platform', 'stardust', 'trotbooks']);
});

test('buildProfileOptions falls back to the default profile when nothing matches', t => {
	const options = buildProfileOptions(CONFIG, 'some unrelated task');
	t.is(options[0]!.name, 'platform');
	t.true(options[0]!.isDefault);
	t.deepEqual(options[0]!.matchedKeywords, []);
});

test('buildProfileOptions orders secondary keyword matches ahead of non-matches', t => {
	const options = buildProfileOptions(CONFIG, 'stardust and trot work');
	t.is(options[0]!.name, 'stardust');
	t.is(options[1]!.name, 'trotbooks');
	t.deepEqual(options[1]!.matchedKeywords, ['trot']);
	// Remaining profiles keep config declaration order.
	t.deepEqual([options[2]!.name, options[3]!.name], ['platform', 'hive']);
});

// A default profile declared late in the config is the realistic case: Charlie's
// own `default_profile: platform` is the 11th profile in the file, so a keyword
// match used to bury it ten rows down.
const LATE_DEFAULT_CONFIG = makeConfig(
	{
		personal: {display_name: 'Personal', keywords: ['personal']},
		stardust: {display_name: 'Stardust Jams', keywords: ['stardust', 'jams']},
		trotbooks: {display_name: 'TrotBooks', keywords: ['trotbooks', 'trot']},
		platform: {display_name: 'Platform', keywords: ['platform', 'sllib']},
		hive: {display_name: 'The Hive', keywords: ['hive', 'bee']},
	},
	'platform',
);

test('buildProfileOptions keeps the default second when a keyword matches', t => {
	const options = buildProfileOptions(
		LATE_DEFAULT_CONFIG,
		'trotbooks invoices',
	);
	t.deepEqual(
		options.map(o => o.name),
		['trotbooks', 'platform', 'personal', 'stardust', 'hive'],
	);
	t.true(options[1]!.isDefault);
});

test('buildProfileOptions shifts the unmatched list down by exactly one row', t => {
	// The baseline order is what a prompt with no keyword produces. A match must
	// only insert one row at the top, never reshuffle what follows it.
	const baseline = buildProfileOptions(LATE_DEFAULT_CONFIG, 'no keyword here');
	const matched = buildProfileOptions(
		LATE_DEFAULT_CONFIG,
		'trotbooks invoices',
	);
	t.deepEqual(
		matched.slice(1).map(o => o.name),
		baseline.filter(o => o.name !== 'trotbooks').map(o => o.name),
	);
});

test('buildProfileOptions keeps the default after several keyword matches', t => {
	const options = buildProfileOptions(
		LATE_DEFAULT_CONFIG,
		'stardust and trot work',
	);
	t.deepEqual(
		options.map(o => o.name),
		['stardust', 'trotbooks', 'platform', 'personal', 'hive'],
	);
});

test('buildProfileOptions keeps the default second behind an enforced match', t => {
	const options = buildProfileOptions(LATE_DEFAULT_CONFIG, 'stardust trot!');
	t.is(options[0]!.name, 'trotbooks');
	t.true(options[0]!.enforced);
	// Enforcement discards the soft `stardust` match entirely, so the tail is the
	// plain baseline order: default first, then config declaration order.
	t.deepEqual(
		options.map(o => o.name),
		['trotbooks', 'platform', 'personal', 'stardust', 'hive'],
	);
});

test('buildProfileOptions does not duplicate the default when it is the match', t => {
	const options = buildProfileOptions(LATE_DEFAULT_CONFIG, 'sllib cleanup');
	t.deepEqual(
		options.map(o => o.name),
		['platform', 'personal', 'stardust', 'trotbooks', 'hive'],
	);
	t.true(options[0]!.isDefault);
});

test('buildProfileOptions preserves config order for the non-matching tail', t => {
	const options = buildProfileOptions(CONFIG, 'hive stuff');
	t.deepEqual(
		options.map(o => o.name),
		['hive', 'platform', 'stardust', 'trotbooks'],
	);
});

test('buildProfileOptions honors enforced keywords', t => {
	const options = buildProfileOptions(CONFIG, 'stardust trot!');
	t.is(options[0]!.name, 'trotbooks');
	t.true(options[0]!.enforced);
	// Every profile is still reachable by arrowing — enforcement only reorders.
	t.is(options.length, 4);
});

test('buildProfileOptions orders blank input like an unmatched prompt', t => {
	// The picker is on screen before a single character is typed, so blank input
	// has to yield the same default-first list an unmatched word would — not an
	// empty box that fills in on the first keystroke.
	const options = buildProfileOptions(CONFIG, '   ');
	t.is(options.length, 4);
	t.is(options[0]!.name, 'platform');
	t.true(options[0]!.isDefault);
	t.deepEqual(
		options.map(o => o.name),
		['platform', 'stardust', 'trotbooks', 'hive'],
	);
});

test('buildProfileOptions marks the default profile even when it is not first', t => {
	const options = buildProfileOptions(CONFIG, 'hive stuff');
	const platform = options.find(o => o.name === 'platform')!;
	t.true(platform.isDefault);
});

test('buildProfileOptions carries the display name for each option', t => {
	const options = buildProfileOptions(CONFIG, 'stardust');
	t.is(options[0]!.displayName, 'Stardust Jams');
});

test('buildProfileOptions on a single-profile config yields one option', t => {
	const solo = makeConfig({only: {display_name: 'Only One'}});
	const options = buildProfileOptions(solo, 'anything');
	t.is(options.length, 1);
	t.is(options[0]!.name, 'only');
	t.true(options[0]!.isDefault);
});

// ============================================================================
// buildProfileOptions — issue-key prefixes
//
// An issue key is a name, not a description, so there are no keywords to score
// it against. Its prefix still says which profiles could own it, and the
// picker ranks on that instead — behind a leading row that names no profile at
// all, so Enter-Enter keeps idow's tracker-project lookup.
// ============================================================================

const PREFIX_CONFIG = makeConfig(
	{
		platform: {display_name: 'Platform', keywords: ['platform']},
		stardust: {
			display_name: 'Stardust Jams',
			keywords: ['stardust'],
			team_prefix: 'SDJ',
		},
		hive: {
			display_name: 'The Hive',
			keywords: ['hive'],
			tracker_projects: ['KAN'],
		},
	},
	'platform',
	undefined,
	'STA',
);

test('buildProfileOptions leads an issue key with the profile-less row', t => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'SDJ-42');
	t.is(options[0]!.name, null);
	t.is(options[0]!.displayName, DEFERRED_PROFILE_DISPLAY_NAME);
});

test('buildProfileOptions ranks the profile owning the key prefix first', t => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'SDJ-42');
	t.is(options[1]!.name, 'stardust');
	t.is(options[1]!.matchedPrefix, 'SDJ');
});

test('buildProfileOptions treats a tracker_projects entry as a project key claim', t => {
	// Jira issue keys ARE their project key, so `tracker_projects: [KAN]` and
	// `KAN-12` are the same statement about ownership.
	const options = buildProfileOptions(PREFIX_CONFIG, 'KAN-12');
	t.is(options[1]!.name, 'hive');
	t.is(options[1]!.matchedPrefix, 'KAN');
});

test('buildProfileOptions treats profiles with no team_prefix as claiming the global one', t => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'STA-7');
	// stardust declared SDJ, so it does not claim STA and drops to the tail.
	t.deepEqual(
		options.map(o => o.name),
		[null, 'platform', 'hive', 'stardust'],
	);
	// Inheritance is not a statement about this key, so it earns no hint.
	t.is(options[1]!.matchedPrefix, undefined);
});

test('buildProfileOptions ranks explicit prefix claims above inherited ones', t => {
	const config = makeConfig(
		{
			platform: {display_name: 'Platform'},
			stardust: {display_name: 'Stardust Jams', team_prefix: 'STA'},
		},
		'platform',
		undefined,
		'STA',
	);
	const options = buildProfileOptions(config, 'STA-9');
	t.deepEqual(
		options.map(o => o.name),
		[null, 'stardust', 'platform'],
	);
});

test('buildProfileOptions still lists every profile for a claimed prefix', t => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'SDJ-42');
	t.deepEqual(
		options.map(o => o.name),
		[null, 'stardust', 'platform', 'hive'],
	);
});

test('buildProfileOptions reads the prefix out of a Linear issue URL', t => {
	const options = buildProfileOptions(
		PREFIX_CONFIG,
		'https://linear.app/acme/issue/SDJ-42/some-slug',
	);
	t.is(options[1]!.name, 'stardust');
	t.is(options[1]!.matchedPrefix, 'SDJ');
});

test('buildProfileOptions leaves an unclaimed prefix on the keyword path', t => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'ZZZ-1');
	t.is(options[0]!.name, 'platform');
	t.true(options[0]!.isDefault);
});

test('buildProfileOptions ignores prefixes for bare numbers', t => {
	// '42' means STA-42 only after config expands it, and the profile that
	// expansion implies is exactly what idow is better placed to decide.
	const options = buildProfileOptions(PREFIX_CONFIG, '42');
	t.is(options[0]!.name, 'platform');
});

// beads IDs — beads profiles are not 1:1 with issue trackers: one database
// backs work belonging to several profiles, so the tracker-project lookup that
// serves Linear and Jira can only guess here. The choice has to be on screen.

const BEADS_CONFIG: PappardelleConfig = {
	...makeConfig(
		{
			// Both name a prefix of their own, so neither inherits 'pap'.
			platform: {
				display_name: 'Platform',
				keywords: ['platform'],
				team_prefix: 'STA',
			},
			stardust: {
				display_name: 'Stardust Jams',
				keywords: ['stardust'],
				team_prefix: 'SDJ',
			},
			vendor: {
				display_name: 'Vendor SDK',
				team_prefix: 'VEN',
				tracker_projects: ['vendor-sdk'],
			},
		},
		'platform',
		undefined,
		'pap',
	),
	issue_tracker: {provider: 'beads'},
};

test('resolvePromptSubmit opens the picker for a beads ID nothing claims', t => {
	const result = resolvePromptSubmit(BEADS_CONFIG, 'pap-a1b2');
	t.is(result.kind, 'pick');
	if (result.kind !== 'pick') return;
	// The preselected row names a real profile — the same one idow falls back
	// to — rather than a deferred lookup with nothing to resolve against.
	t.is(result.options[0]!.name, 'platform');
	t.true(result.options[0]!.isDefault);
});

test('buildProfileOptions omits the deferred row for a beads ID nothing claims', t => {
	const options = buildProfileOptions(BEADS_CONFIG, 'pap-a1b2');
	t.false(options.some(o => o.name === null));
	t.deepEqual(
		options.map(o => o.name),
		['platform', 'stardust', 'vendor'],
	);
});

test('buildProfileOptions leads a claimed beads prefix with the deferred row', t => {
	// 'vendor-sdk' is spelled in tracker_projects, so idow's lookup does resolve
	// it and stays the preselected answer — the picker only adds the override.
	const options = buildProfileOptions(BEADS_CONFIG, 'vendor-sdk-a1b2');
	t.is(options[0]!.name, null);
	t.is(options[0]!.displayName, DEFERRED_PROFILE_DISPLAY_NAME);
	t.is(options[1]!.name, 'vendor');
	t.is(options[1]!.matchedPrefix, 'vendor-sdk');
});

test('resolvePromptSubmit opens the picker for a claimed beads prefix', t => {
	const result = resolvePromptSubmit(BEADS_CONFIG, 'vendor-sdk-a1b2');
	t.is(result.kind, 'pick');
});

test('resolvePromptSubmit leaves beads-shaped prose on the keyword path', t => {
	// 'stardust-crash' names no beads prefix, so it is a description and the
	// keyword match leads.
	const result = resolvePromptSubmit(BEADS_CONFIG, 'stardust-crash');
	t.is(result.kind, 'pick');
	if (result.kind !== 'pick') return;
	t.is(result.options[0]!.name, 'stardust');
});

// ============================================================================
// resolvePromptSubmit — which inputs open the picker
// ============================================================================

test('resolvePromptSubmit opens the picker for a free-text prompt', t => {
	const result = resolvePromptSubmit(CONFIG, 'fix the stardust map crash');
	t.is(result.kind, 'pick');
	if (result.kind !== 'pick') return;
	t.is(result.options[0]!.name, 'stardust');
});

test('resolvePromptSubmit spawns immediately for inputs carrying no key prefix', t => {
	// A bare number borrows its prefix from config rather than stating one, so
	// there is no prefix to match profiles against — behaves exactly as it did
	// before the picker existed: one Enter, no --profile flag, so idow resolves
	// the profile from the fetched issue's tracker project.
	const result = resolvePromptSubmit(CONFIG, '123');
	t.is(result.kind, 'spawn');
	if (result.kind !== 'spawn') return;
	t.is(result.profileName, null);
});

test('resolvePromptSubmit spawns immediately for an issue key no profile claims', t => {
	const result = resolvePromptSubmit(CONFIG, 'ZZZ-123');
	t.is(result.kind, 'spawn');
	if (result.kind !== 'spawn') return;
	t.is(result.profileName, null);
});

test('resolvePromptSubmit opens the picker for an issue key whose prefix is claimed', t => {
	for (const input of [
		'STA-123',
		'https://linear.app/acme/issue/STA-123/some-slug',
	]) {
		const result = resolvePromptSubmit(CONFIG, input);
		t.is(result.kind, 'pick');
		if (result.kind !== 'pick') continue;
		// The deferred lookup leads, so Enter-Enter still spawns with no
		// --profile — the picker only adds the ability to override it.
		t.is(result.options[0]!.name, null);
	}
});

test('resolvePromptSubmit ignores blank input', t => {
	t.is(resolvePromptSubmit(CONFIG, '   ').kind, 'none');
});

test('resolvePromptSubmit spawns with no profile when config failed to load', t => {
	const result = resolvePromptSubmit(null, 'fix the stardust map crash');
	t.is(result.kind, 'spawn');
	if (result.kind !== 'spawn') return;
	t.is(result.profileName, null);
});

test('resolvePromptSubmit trims surrounding whitespace before deciding', t => {
	const result = resolvePromptSubmit(CONFIG, '  ZZZ-123  ');
	t.is(result.kind, 'spawn');
});

// ============================================================================
// computePickerWindow — scrolling
// ============================================================================

test('computePickerWindow shows everything when the list fits', t => {
	t.deepEqual(computePickerWindow(3, 0, 4), {
		start: 0,
		end: 3,
		above: 0,
		below: 0,
	});
});

test('computePickerWindow keeps the top window while the selection is visible', t => {
	t.deepEqual(computePickerWindow(9, 2, 4), {
		start: 0,
		end: 4,
		above: 0,
		below: 5,
	});
});

test('computePickerWindow scrolls down once the selection passes the window', t => {
	t.deepEqual(computePickerWindow(9, 4, 4), {
		start: 1,
		end: 5,
		above: 1,
		below: 4,
	});
});

test('computePickerWindow pins to the end at the last item', t => {
	t.deepEqual(computePickerWindow(9, 8, 4), {
		start: 5,
		end: 9,
		above: 5,
		below: 0,
	});
});

test('computePickerWindow scrolls back up when selection moves above the window', t => {
	t.deepEqual(computePickerWindow(9, 0, 4), {
		start: 0,
		end: 4,
		above: 0,
		below: 5,
	});
});

test('computePickerWindow handles an empty list', t => {
	t.deepEqual(computePickerWindow(0, 0, 4), {
		start: 0,
		end: 0,
		above: 0,
		below: 0,
	});
});

test('computePickerWindow clamps a maxVisible of zero to one row', t => {
	t.deepEqual(computePickerWindow(5, 3, 0), {
		start: 3,
		end: 4,
		above: 3,
		below: 1,
	});
});

test('PICKER_MAX_VISIBLE is four rows', t => {
	t.is(PICKER_MAX_VISIBLE, 4);
});

// ============================================================================
// handleProfilePickerKey — keyboard
// ============================================================================

const KEY = {
	up: {upArrow: true},
	down: {downArrow: true},
	enter: {return: true},
	escape: {escape: true},
	none: {},
} as const;

test('handleProfilePickerKey moves down and clamps at the end', t => {
	t.deepEqual(handleProfilePickerKey('', KEY.down, 0, 3), {
		action: 'move',
		index: 1,
	});
	t.deepEqual(handleProfilePickerKey('', KEY.down, 2, 3), {
		action: 'move',
		index: 2,
	});
});

test('handleProfilePickerKey moves up and clamps at the start', t => {
	t.deepEqual(handleProfilePickerKey('', KEY.up, 2, 3), {
		action: 'move',
		index: 1,
	});
	t.deepEqual(handleProfilePickerKey('', KEY.up, 0, 3), {
		action: 'move',
		index: 0,
	});
});

test('handleProfilePickerKey supports j/k like the main list', t => {
	t.deepEqual(handleProfilePickerKey('j', KEY.none, 0, 3), {
		action: 'move',
		index: 1,
	});
	t.deepEqual(handleProfilePickerKey('k', KEY.none, 2, 3), {
		action: 'move',
		index: 1,
	});
});

test('handleProfilePickerKey submits on Enter', t => {
	t.deepEqual(handleProfilePickerKey('', KEY.enter, 1, 3), {
		action: 'submit',
		index: 1,
	});
});

test('handleProfilePickerKey goes back on Escape', t => {
	t.deepEqual(handleProfilePickerKey('', KEY.escape, 1, 3), {
		action: 'back',
		index: 1,
	});
});

test('handleProfilePickerKey ignores unrelated keys', t => {
	t.deepEqual(handleProfilePickerKey('x', KEY.none, 1, 3), {
		action: 'ignore',
		index: 1,
	});
});

test('handleProfilePickerKey refuses to submit an empty list', t => {
	t.deepEqual(handleProfilePickerKey('', KEY.enter, 0, 0), {
		action: 'ignore',
		index: 0,
	});
});

// ============================================================================
// buildProfileOptions — profile emoji (mirrors the ticket rail's slot rules)
// ============================================================================

const EMOJI_CONFIG = makeConfig(
	{
		platform: {
			display_name: 'Platform',
			keywords: ['platform'],
			emoji: '\u2699\ufe0f',
		},
		stardust: {
			display_name: 'Stardust Jams',
			keywords: ['stardust'],
			emoji: '\ud83c\udfb8',
		},
		hive: {display_name: 'The Hive', keywords: ['hive']},
	},
	'platform',
);

test('buildProfileOptions carries each profile emoji', t => {
	const options = buildProfileOptions(EMOJI_CONFIG, 'stardust');
	t.is(options.find(o => o.name === 'stardust')!.emoji, '\ud83c\udfb8');
	t.is(options.find(o => o.name === 'platform')!.emoji, '\u2699\ufe0f');
});

test('buildProfileOptions reserves a blank slot for an emoji-less profile when siblings have one', t => {
	// Matches the rail: '' means "slot exists, this row has nothing" so rows
	// still line up. Only `undefined` means "no slot at all".
	const options = buildProfileOptions(EMOJI_CONFIG, 'stardust');
	t.is(options.find(o => o.name === 'hive')!.emoji, '');
});

test('buildProfileOptions reserves the emoji slot on the profile-less row too', t => {
	// It leads the list for issue keys, so if it skipped the slot the row you
	// land on first would be the one hanging two columns left of the rest.
	const options = buildProfileOptions(EMOJI_CONFIG, 'STA-1');
	t.is(options[0]!.name, null);
	t.is(options[0]!.emoji, '');
});

test('buildProfileOptions leaves emoji undefined when no profile configures one', t => {
	const options = buildProfileOptions(CONFIG, 'stardust');
	for (const option of options) {
		t.is(option.emoji, undefined);
	}
});

test('buildProfileOptions falls back to default_emoji for profiles without their own', t => {
	const config = makeConfig(
		{
			platform: {display_name: 'Platform', keywords: ['platform']},
			stardust: {
				display_name: 'Stardust Jams',
				keywords: ['stardust'],
				emoji: '\ud83c\udfb8',
			},
		},
		'platform',
		'\ud83c\udf5d',
	);
	const options = buildProfileOptions(config, 'stardust');
	t.is(options.find(o => o.name === 'stardust')!.emoji, '\ud83c\udfb8');
	t.is(options.find(o => o.name === 'platform')!.emoji, '\ud83c\udf5d');
});

// ============================================================================
// focusFrame — which box owns the double outline
// ============================================================================

test('focusFrame gives the focused box a bright double outline', t => {
	t.deepEqual(focusFrame(true), {borderStyle: 'double', isDim: false});
});

test('focusFrame gives the unfocused box a dim round outline', t => {
	t.deepEqual(focusFrame(false), {borderStyle: 'round', isDim: true});
});

test('focusFrame never marks two states the same', t => {
	t.notDeepEqual(focusFrame(true), focusFrame(false));
});
