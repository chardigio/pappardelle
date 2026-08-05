import test from 'ava';
import {
	buildProfileOptions,
	computePickerWindow,
	handleProfilePickerKey,
	resolvePromptSubmit,
	focusFrame,
	PICKER_MAX_VISIBLE,
} from './profile-picker.ts';
import type {PappardelleConfig} from './config.ts';

// ============================================================================
// Test helpers
// ============================================================================

function makeConfig(
	profiles: Record<
		string,
		{display_name: string; keywords?: string[]; emoji?: string}
	>,
	defaultProfile?: string,
	defaultEmoji?: string,
): PappardelleConfig {
	return {
		version: 1,
		default_profile: defaultProfile,
		default_emoji: defaultEmoji,
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
	t.deepEqual(options.map(o => o.name).sort(), [
		'hive',
		'platform',
		'stardust',
		'trotbooks',
	]);
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
// resolvePromptSubmit — which inputs open the picker
// ============================================================================

test('resolvePromptSubmit opens the picker for a free-text prompt', t => {
	const result = resolvePromptSubmit(CONFIG, 'fix the stardust map crash');
	t.is(result.kind, 'pick');
	if (result.kind !== 'pick') return;
	t.is(result.options[0]!.name, 'stardust');
});

test('resolvePromptSubmit spawns immediately for an issue key, deferring the profile', t => {
	// Regression guard: issue-key inputs must behave exactly as they did before
	// the picker existed — one Enter, no --profile flag, so idow resolves the
	// profile from the fetched issue's tracker project.
	for (const input of [
		'STA-123',
		'123',
		'https://linear.app/acme/issue/STA-123/some-slug',
	]) {
		const result = resolvePromptSubmit(CONFIG, input);
		t.is(result.kind, 'spawn');
		if (result.kind !== 'spawn') continue;
		t.is(result.profileName, null);
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
	const result = resolvePromptSubmit(CONFIG, '  STA-123  ');
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
