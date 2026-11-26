import {test, expect} from 'bun:test';
import {testConfig} from '../test/helpers/config-fixtures.ts';
import {press} from '../test/helpers/key-press.ts';
import {
	buildProfileOptions,
	computePickerWindow,
	filterProfileOptions,
	handleFilterablePickerKey,
	handleProfilePickerKey,
	pasteIntoFilterablePicker,
	resolvePromptSubmit,
	pickerOptions,
	focusFrame,
	PICKER_MAX_VISIBLE,
} from './profile-picker.ts';
import {
	DEFERRED_PROFILE_DISPLAY_NAME,
	type ConfigLoad,
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
	return testConfig({
		default_profile: defaultProfile,
		default_emoji: defaultEmoji,
		team_prefix: teamPrefix,
		profiles,
	});
}

const valid = (config: PappardelleConfig): ConfigLoad => ({
	kind: 'valid',
	config,
});

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

test('buildProfileOptions puts the keyword-matched profile first', () => {
	const options = buildProfileOptions(CONFIG, 'fix the stardust map crash');
	expect(options[0]!.name).toBe('stardust');
	expect(options[0]!.matchedKeywords).toStrictEqual(['stardust']);
	expect(options[0]!.isDefault).toBe(false);
});

test('buildProfileOptions lists every profile exactly once', () => {
	const options = buildProfileOptions(CONFIG, 'fix the stardust map crash');
	expect(options.length).toBe(4);
	// Sorted with an explicit comparator because an option's name is nullable —
	// the profile-less row exists, just never on the keyword path.
	const names = options.map(o => o.name);
	names.sort((a, b) => String(a).localeCompare(String(b)));
	expect(names).toStrictEqual(['hive', 'platform', 'stardust', 'trotbooks']);
});

test('buildProfileOptions falls back to the default profile when nothing matches', () => {
	const options = buildProfileOptions(CONFIG, 'some unrelated task');
	expect(options[0]!.name).toBe('platform');
	expect(options[0]!.isDefault).toBe(true);
	expect(options[0]!.matchedKeywords).toStrictEqual([]);
});

test('buildProfileOptions orders secondary keyword matches ahead of non-matches', () => {
	const options = buildProfileOptions(CONFIG, 'stardust and trot work');
	expect(options[0]!.name).toBe('stardust');
	expect(options[1]!.name).toBe('trotbooks');
	expect(options[1]!.matchedKeywords).toStrictEqual(['trot']);
	// Remaining profiles keep config declaration order.
	expect([options[2]!.name, options[3]!.name]).toStrictEqual([
		'platform',
		'hive',
	]);
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

test('buildProfileOptions keeps the default second when a keyword matches', () => {
	const options = buildProfileOptions(
		LATE_DEFAULT_CONFIG,
		'trotbooks invoices',
	);
	expect(options.map(o => o.name)).toStrictEqual([
		'trotbooks',
		'platform',
		'personal',
		'stardust',
		'hive',
	]);
	expect(options[1]!.isDefault).toBe(true);
});

test('buildProfileOptions shifts the unmatched list down by exactly one row', () => {
	// The baseline order is what a prompt with no keyword produces. A match must
	// only insert one row at the top, never reshuffle what follows it.
	const baseline = buildProfileOptions(LATE_DEFAULT_CONFIG, 'no keyword here');
	const matched = buildProfileOptions(
		LATE_DEFAULT_CONFIG,
		'trotbooks invoices',
	);
	expect(matched.slice(1).map(o => o.name)).toStrictEqual(
		baseline.filter(o => o.name !== 'trotbooks').map(o => o.name),
	);
});

test('buildProfileOptions keeps the default after several keyword matches', () => {
	const options = buildProfileOptions(
		LATE_DEFAULT_CONFIG,
		'stardust and trot work',
	);
	expect(options.map(o => o.name)).toStrictEqual([
		'stardust',
		'trotbooks',
		'platform',
		'personal',
		'hive',
	]);
});

test('buildProfileOptions keeps the default second behind an enforced match', () => {
	const options = buildProfileOptions(LATE_DEFAULT_CONFIG, 'stardust trot!');
	expect(options[0]!.name).toBe('trotbooks');
	expect(options[0]!.enforced).toBe(true);
	// Enforcement discards the soft `stardust` match entirely, so the tail is the
	// plain baseline order: default first, then config declaration order.
	expect(options.map(o => o.name)).toStrictEqual([
		'trotbooks',
		'platform',
		'personal',
		'stardust',
		'hive',
	]);
});

test('buildProfileOptions does not duplicate the default when it is the match', () => {
	const options = buildProfileOptions(LATE_DEFAULT_CONFIG, 'sllib cleanup');
	expect(options.map(o => o.name)).toStrictEqual([
		'platform',
		'personal',
		'stardust',
		'trotbooks',
		'hive',
	]);
	expect(options[0]!.isDefault).toBe(true);
});

test('buildProfileOptions preserves config order for the non-matching tail', () => {
	const options = buildProfileOptions(CONFIG, 'hive stuff');
	expect(options.map(o => o.name)).toStrictEqual([
		'hive',
		'platform',
		'stardust',
		'trotbooks',
	]);
});

test('buildProfileOptions honors enforced keywords', () => {
	const options = buildProfileOptions(CONFIG, 'stardust trot!');
	expect(options[0]!.name).toBe('trotbooks');
	expect(options[0]!.enforced).toBe(true);
	// Every profile is still reachable by arrowing — enforcement only reorders.
	expect(options.length).toBe(4);
});

test('buildProfileOptions orders blank input like an unmatched prompt', () => {
	// The picker is on screen before a single character is typed, so blank input
	// has to yield the same default-first list an unmatched word would — not an
	// empty box that fills in on the first keystroke.
	const options = buildProfileOptions(CONFIG, '   ');
	expect(options.length).toBe(4);
	expect(options[0]!.name).toBe('platform');
	expect(options[0]!.isDefault).toBe(true);
	expect(options.map(o => o.name)).toStrictEqual([
		'platform',
		'stardust',
		'trotbooks',
		'hive',
	]);
});

test('buildProfileOptions marks the default profile even when it is not first', () => {
	const options = buildProfileOptions(CONFIG, 'hive stuff');
	const platform = options.find(o => o.name === 'platform')!;
	expect(platform.isDefault).toBe(true);
});

test('buildProfileOptions carries the display name for each option', () => {
	const options = buildProfileOptions(CONFIG, 'stardust');
	expect(options[0]!.displayName).toBe('Stardust Jams');
});

test('buildProfileOptions on a single-profile config yields one option', () => {
	const solo = makeConfig({only: {display_name: 'Only One'}});
	const options = buildProfileOptions(solo, 'anything');
	expect(options.length).toBe(1);
	expect(options[0]!.name).toBe('only');
	expect(options[0]!.isDefault).toBe(true);
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

test('buildProfileOptions leads an issue key with the profile-less row', () => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'SDJ-42');
	expect(options[0]!.name).toBe(null);
	expect(options[0]!.displayName).toBe(DEFERRED_PROFILE_DISPLAY_NAME);
});

test('buildProfileOptions ranks the profile owning the key prefix first', () => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'SDJ-42');
	expect(options[1]!.name).toBe('stardust');
	expect(options[1]!.matchedPrefix).toBe('SDJ');
});

test('buildProfileOptions treats a tracker_projects entry as a project key claim', () => {
	// Jira issue keys ARE their project key, so `tracker_projects: [KAN]` and
	// `KAN-12` are the same statement about ownership.
	const options = buildProfileOptions(PREFIX_CONFIG, 'KAN-12');
	expect(options[1]!.name).toBe('hive');
	expect(options[1]!.matchedPrefix).toBe('KAN');
});

test('buildProfileOptions treats profiles with no team_prefix as claiming the global one', () => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'STA-7');
	// stardust declared SDJ, so it does not claim STA and drops to the tail.
	expect(options.map(o => o.name)).toStrictEqual([
		null,
		'platform',
		'hive',
		'stardust',
	]);
	// Inheritance is not a statement about this key, so it earns no hint.
	expect(options[1]!.matchedPrefix).toBe(undefined);
});

test('buildProfileOptions ranks explicit prefix claims above inherited ones', () => {
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
	expect(options.map(o => o.name)).toStrictEqual([
		null,
		'stardust',
		'platform',
	]);
});

test('buildProfileOptions still lists every profile for a claimed prefix', () => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'SDJ-42');
	expect(options.map(o => o.name)).toStrictEqual([
		null,
		'stardust',
		'platform',
		'hive',
	]);
});

test('buildProfileOptions reads the prefix out of a Linear issue URL', () => {
	const options = buildProfileOptions(
		PREFIX_CONFIG,
		'https://linear.app/acme/issue/SDJ-42/some-slug',
	);
	expect(options[1]!.name).toBe('stardust');
	expect(options[1]!.matchedPrefix).toBe('SDJ');
});

test('buildProfileOptions leaves an unclaimed prefix on the keyword path', () => {
	const options = buildProfileOptions(PREFIX_CONFIG, 'ZZZ-1');
	expect(options[0]!.name).toBe('platform');
	expect(options[0]!.isDefault).toBe(true);
});

test('buildProfileOptions ignores prefixes for bare numbers', () => {
	// '42' means STA-42 only after config expands it, and the profile that
	// expansion implies is exactly what idow is better placed to decide.
	const options = buildProfileOptions(PREFIX_CONFIG, '42');
	expect(options[0]!.name).toBe('platform');
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

test('resolvePromptSubmit opens the picker for a beads ID nothing claims', () => {
	const result = resolvePromptSubmit(valid(BEADS_CONFIG), 'pap-a1b2');
	expect(result.kind).toBe('pick');
	if (result.kind !== 'pick') return;
	// The preselected row names a real profile — the same one idow falls back
	// to — rather than a deferred lookup with nothing to resolve against.
	expect(result.options[0]!.name).toBe('platform');
	expect(result.options[0]!.isDefault).toBe(true);
});

test('buildProfileOptions omits the deferred row for a beads ID nothing claims', () => {
	const options = buildProfileOptions(BEADS_CONFIG, 'pap-a1b2');
	expect(options.some(o => o.name === null)).toBe(false);
	expect(options.map(o => o.name)).toStrictEqual([
		'platform',
		'stardust',
		'vendor',
	]);
});

test('buildProfileOptions leads a claimed beads prefix with the deferred row', () => {
	// 'vendor-sdk' is spelled in tracker_projects, so idow's lookup does resolve
	// it and stays the preselected answer — the picker only adds the override.
	const options = buildProfileOptions(BEADS_CONFIG, 'vendor-sdk-a1b2');
	expect(options[0]!.name).toBe(null);
	expect(options[0]!.displayName).toBe(DEFERRED_PROFILE_DISPLAY_NAME);
	expect(options[1]!.name).toBe('vendor');
	expect(options[1]!.matchedPrefix).toBe('vendor-sdk');
});

test('resolvePromptSubmit opens the picker for a claimed beads prefix', () => {
	const result = resolvePromptSubmit(valid(BEADS_CONFIG), 'vendor-sdk-a1b2');
	expect(result.kind).toBe('pick');
});

test('resolvePromptSubmit leaves beads-shaped prose on the keyword path', () => {
	// 'stardust-crash' names no beads prefix, so it is a description and the
	// keyword match leads.
	const result = resolvePromptSubmit(valid(BEADS_CONFIG), 'stardust-crash');
	expect(result.kind).toBe('pick');
	if (result.kind !== 'pick') return;
	expect(result.options[0]!.name).toBe('stardust');
});

// ============================================================================
// resolvePromptSubmit — which inputs open the picker
// ============================================================================

test('resolvePromptSubmit opens the picker for a free-text prompt', () => {
	const result = resolvePromptSubmit(
		valid(CONFIG),
		'fix the stardust map crash',
	);
	expect(result.kind).toBe('pick');
	if (result.kind !== 'pick') return;
	expect(result.options[0]!.name).toBe('stardust');
});

test('resolvePromptSubmit spawns immediately for inputs carrying no key prefix', () => {
	// A bare number borrows its prefix from config rather than stating one, so
	// there is no prefix to match profiles against — behaves exactly as it did
	// before the picker existed: one Enter, no --profile flag, so idow resolves
	// the profile from the fetched issue's tracker project.
	const result = resolvePromptSubmit(valid(CONFIG), '123');
	expect(result.kind).toBe('spawn');
	if (result.kind !== 'spawn') return;
	expect(result.profileName).toBe(null);
});

test('resolvePromptSubmit spawns immediately for an issue key no profile claims', () => {
	const result = resolvePromptSubmit(valid(CONFIG), 'ZZZ-123');
	expect(result.kind).toBe('spawn');
	if (result.kind !== 'spawn') return;
	expect(result.profileName).toBe(null);
});

test('resolvePromptSubmit opens the picker for an issue key whose prefix is claimed', () => {
	for (const input of [
		'STA-123',
		'https://linear.app/acme/issue/STA-123/some-slug',
	]) {
		const result = resolvePromptSubmit(valid(CONFIG), input);
		expect(result.kind).toBe('pick');
		if (result.kind !== 'pick') continue;
		// The deferred lookup leads, so Enter-Enter still spawns with no
		// --profile — the picker only adds the ability to override it.
		expect(result.options[0]!.name).toBe(null);
	}
});

test('resolvePromptSubmit gives unclaimed inputs a deferred-only picker when an agent can be swapped in', () => {
	for (const input of ['123', 'ZZZ-123']) {
		const result = resolvePromptSubmit(valid(CONFIG), input, true);
		expect(result.kind).toBe('pick');
		if (result.kind !== 'pick') continue;
		expect(result.options.map(option => option.kind)).toStrictEqual([
			'deferred',
		]);
	}
});

test('pickerOptions only narrows inputs the picker would otherwise skip', () => {
	expect(
		pickerOptions(CONFIG, '123', true).map(option => option.kind),
	).toStrictEqual(['deferred']);
	expect(pickerOptions(CONFIG, 'STA-123', true)).toStrictEqual(
		buildProfileOptions(CONFIG, 'STA-123'),
	);
	expect(pickerOptions(CONFIG, '123', false)).toStrictEqual(
		buildProfileOptions(CONFIG, '123'),
	);
});

test("pickerOptions leads with an existing space's saved profile", () => {
	const guessed = buildProfileOptions(CONFIG, 'STA-123');
	const options = pickerOptions(CONFIG, 'STA-123', false, 'hive');
	expect(options[0]?.name).toBe('hive');
	expect(options.length).toBe(guessed.length);
	expect(pickerOptions(CONFIG, 'STA-123', false, 'gone')).toStrictEqual(
		guessed,
	);
});

test('resolvePromptSubmit ignores blank input', () => {
	expect(resolvePromptSubmit(valid(CONFIG), '   ').kind).toBe('none');
});

test('resolvePromptSubmit starts nothing while the config is invalid', () => {
	const result = resolvePromptSubmit(
		{kind: 'invalid', errors: ['agent_profiles.opus.model: must be a string']},
		'123',
	);
	expect(result.kind).toBe('none');
});

test('resolvePromptSubmit spawns with no profile when there is no config', () => {
	const result = resolvePromptSubmit(
		{kind: 'missing'},
		'fix the stardust map crash',
	);
	expect(result.kind).toBe('spawn');
	if (result.kind !== 'spawn') return;
	expect(result.profileName).toBe(null);
});

test('resolvePromptSubmit trims surrounding whitespace before deciding', () => {
	const result = resolvePromptSubmit(valid(CONFIG), '  ZZZ-123  ');
	expect(result.kind).toBe('spawn');
});

// ============================================================================
// computePickerWindow — scrolling
// ============================================================================

test('computePickerWindow shows everything when the list fits', () => {
	expect(computePickerWindow(3, 0, 4)).toStrictEqual({
		start: 0,
		end: 3,
		above: 0,
		below: 0,
	});
});

test('computePickerWindow keeps the top window while the selection is visible', () => {
	expect(computePickerWindow(9, 2, 4)).toStrictEqual({
		start: 0,
		end: 4,
		above: 0,
		below: 5,
	});
});

test('computePickerWindow scrolls down once the selection passes the window', () => {
	expect(computePickerWindow(9, 4, 4)).toStrictEqual({
		start: 1,
		end: 5,
		above: 1,
		below: 4,
	});
});

test('computePickerWindow pins to the end at the last item', () => {
	expect(computePickerWindow(9, 8, 4)).toStrictEqual({
		start: 5,
		end: 9,
		above: 5,
		below: 0,
	});
});

test('computePickerWindow scrolls back up when selection moves above the window', () => {
	expect(computePickerWindow(9, 0, 4)).toStrictEqual({
		start: 0,
		end: 4,
		above: 0,
		below: 5,
	});
});

test('computePickerWindow handles an empty list', () => {
	expect(computePickerWindow(0, 0, 4)).toStrictEqual({
		start: 0,
		end: 0,
		above: 0,
		below: 0,
	});
});

test('computePickerWindow clamps a maxVisible of zero to one row', () => {
	expect(computePickerWindow(5, 3, 0)).toStrictEqual({
		start: 3,
		end: 4,
		above: 3,
		below: 1,
	});
});

test('PICKER_MAX_VISIBLE is four rows', () => {
	expect(PICKER_MAX_VISIBLE).toBe(4);
});

// ============================================================================
// handleProfilePickerKey — keyboard
// ============================================================================

const KEY = {
	up: press('up'),
	down: press('down'),
	enter: press('return'),
	escape: press('escape'),
} as const;

test('handleProfilePickerKey moves down and clamps at the end', () => {
	expect(handleProfilePickerKey(KEY.down, 0, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
	expect(handleProfilePickerKey(KEY.down, 2, 3)).toStrictEqual({
		action: 'move',
		index: 2,
	});
});

test('handleProfilePickerKey moves up and clamps at the start', () => {
	expect(handleProfilePickerKey(KEY.up, 2, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
	expect(handleProfilePickerKey(KEY.up, 0, 3)).toStrictEqual({
		action: 'move',
		index: 0,
	});
});

test('handleProfilePickerKey opens the agent override on a', () => {
	expect(handleProfilePickerKey(press('a'), 1, 3)).toStrictEqual({
		action: 'agent',
		index: 1,
	});
	expect(handleProfilePickerKey(press('a'), 0, 0)).toStrictEqual({
		action: 'ignore',
		index: 0,
	});
	expect(handleProfilePickerKey(press('a', {ctrl: true}), 1, 3)).toStrictEqual({
		action: 'ignore',
		index: 1,
	});
});

test('handleProfilePickerKey supports j/k like the main list', () => {
	expect(handleProfilePickerKey(press('j'), 0, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
	expect(handleProfilePickerKey(press('k'), 2, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
});

test('handleProfilePickerKey submits on Enter', () => {
	expect(handleProfilePickerKey(KEY.enter, 1, 3)).toStrictEqual({
		action: 'submit',
		index: 1,
	});
});

test('handleProfilePickerKey goes back on Escape', () => {
	expect(handleProfilePickerKey(KEY.escape, 1, 3)).toStrictEqual({
		action: 'back',
		index: 1,
	});
});

test('handleProfilePickerKey ignores unrelated keys', () => {
	expect(handleProfilePickerKey(press('x'), 1, 3)).toStrictEqual({
		action: 'ignore',
		index: 1,
	});
});

test('handleProfilePickerKey refuses to submit an empty list', () => {
	expect(handleProfilePickerKey(KEY.enter, 0, 0)).toStrictEqual({
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

test('buildProfileOptions carries each profile emoji', () => {
	const options = buildProfileOptions(EMOJI_CONFIG, 'stardust');
	expect(options.find(o => o.name === 'stardust')!.emoji).toBe('\ud83c\udfb8');
	expect(options.find(o => o.name === 'platform')!.emoji).toBe('\u2699\ufe0f');
});

test('buildProfileOptions reserves a blank slot for an emoji-less profile when siblings have one', () => {
	// Matches the rail: '' means "slot exists, this row has nothing" so rows
	// still line up. Only `undefined` means "no slot at all".
	const options = buildProfileOptions(EMOJI_CONFIG, 'stardust');
	expect(options.find(o => o.name === 'hive')!.emoji).toBe('');
});

test('buildProfileOptions reserves the emoji slot on the profile-less row too', () => {
	// It leads the list for issue keys, so if it skipped the slot the row you
	// land on first would be the one hanging two columns left of the rest.
	const options = buildProfileOptions(EMOJI_CONFIG, 'STA-1');
	expect(options[0]!.name).toBe(null);
	expect(options[0]!.emoji).toBe('');
});

test('buildProfileOptions leaves emoji undefined when no profile configures one', () => {
	const options = buildProfileOptions(CONFIG, 'stardust');
	for (const option of options) {
		expect(option.emoji).toBe(undefined);
	}
});

test('buildProfileOptions falls back to default_emoji for profiles without their own', () => {
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
	expect(options.find(o => o.name === 'stardust')!.emoji).toBe('\ud83c\udfb8');
	expect(options.find(o => o.name === 'platform')!.emoji).toBe('\ud83c\udf5d');
});

// ============================================================================
// focusFrame — which box owns the double outline
// ============================================================================

test('focusFrame gives the focused box a bright double outline', () => {
	expect(focusFrame(true)).toStrictEqual({borderStyle: 'double', isDim: false});
});

test('focusFrame gives the unfocused box a dim round outline', () => {
	expect(focusFrame(false)).toStrictEqual({borderStyle: 'round', isDim: true});
});

test('focusFrame never marks two states the same', () => {
	expect(focusFrame(true)).not.toStrictEqual(focusFrame(false));
});

// ============================================================================
// handleFilterablePickerKey / filterProfileOptions — the `/` filter
// ============================================================================

test('/ starts a filter where j, k and a are text, not keys', () => {
	let {state} = handleFilterablePickerKey(
		{query: null, index: 3},
		press('/'),
		7,
	);
	expect(state).toStrictEqual({query: '', index: 0, indexBeforeQuery: 3});
	for (const char of 'jka') {
		({state} = handleFilterablePickerKey(state, press(char), 7));
	}

	expect(state).toStrictEqual({query: 'jka', index: 0, indexBeforeQuery: 3});
	({state} = handleFilterablePickerKey(state, press('backspace'), 0));
	expect(state.query).toBe('jk');
});

test('without a filter the picker keys pass through', () => {
	expect(
		handleFilterablePickerKey({query: null, index: 1}, press('a'), 3),
	).toStrictEqual({
		state: {query: null, index: 1},
		action: 'agent',
	});
	expect(
		handleFilterablePickerKey({query: null, index: 1}, press('j'), 3),
	).toStrictEqual({
		state: {query: null, index: 2},
	});
});

test('Esc while filtering leaves the filter, not the picker', () => {
	expect(
		handleFilterablePickerKey(
			{query: 'so', index: 1, indexBeforeQuery: 4},
			press('escape'),
			2,
		),
	).toStrictEqual({state: {query: null, index: 4}});
	expect(
		handleFilterablePickerKey({query: null, index: 1}, press('escape'), 7)
			.action,
	).toBe('back');
});

test('Enter while filtering selects the highlighted match, if any', () => {
	expect(
		handleFilterablePickerKey({query: 'so', index: 1}, press('return'), 2)
			.action,
	).toBe('select');
	expect(
		handleFilterablePickerKey({query: 'zz', index: 0}, press('return'), 0)
			.action,
	).toBe(undefined);
});

test('arrows move within the filtered list', () => {
	const move = (name: string) =>
		handleFilterablePickerKey({query: 'h', index: 1}, press(name), 2).state
			.index;
	expect(move('down')).toBe(1);
	expect(move('up')).toBe(0);
});

test('filterProfileOptions matches a display name or a profile key', () => {
	const options = buildProfileOptions(
		makeConfig(
			{
				'rex-ai': {display_name: 'REx AI'},
				ste: {display_name: 'Personal'},
			},
			'rex-ai',
		),
		'',
	);
	const names = (query: string) =>
		filterProfileOptions(options, query).map(option => option.name);
	expect(names('pers')).toStrictEqual(['ste']);
	expect(names('ste')).toStrictEqual(['ste']);
	expect(names('rx')).toStrictEqual(['rex-ai']);
	expect(names('')).toStrictEqual(['rex-ai', 'ste']);
});

test('a paste extends an open filter on one line and restarts the match list', () => {
	const state = {query: 'fr', index: 3, indexBeforeQuery: 1};
	expect(pasteIntoFilterablePicker(state, 'ont\nend\r\n')).toStrictEqual({
		query: 'front end',
		index: 0,
		indexBeforeQuery: 1,
	});
});

test('a paste is ignored until the filter is opened with /', () => {
	const state = {query: null, index: 2};
	expect(pasteIntoFilterablePicker(state, 'front')).toBe(state);
});
