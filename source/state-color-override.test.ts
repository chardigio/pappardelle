import test from 'ava';
import {
	INK_COLOR_NAMES,
	getStateColorOverride,
	initStateColorOverrides,
	isValidStateColor,
	lookupStateColorOverride,
	resolveStateColor,
	resetStateColorOverrides,
} from './state-color-override.ts';

// ============================================================================
// isValidStateColor
// ============================================================================

test('isValidStateColor accepts 6-digit hex', t => {
	t.true(isValidStateColor('#74d09f'));
	t.true(isValidStateColor('#FFFFFF'));
});

test('isValidStateColor accepts 3-digit hex', t => {
	t.true(isValidStateColor('#abc'));
});

test('isValidStateColor accepts ink color names', t => {
	t.true(isValidStateColor('cyan'));
	t.true(isValidStateColor('magenta'));
	t.true(isValidStateColor('blueBright'));
	t.true(isValidStateColor('gray'));
	t.true(isValidStateColor('grey'));
});

test('isValidStateColor rejects unknown names and malformed hex', t => {
	t.false(isValidStateColor('chartreuse'));
	t.false(isValidStateColor('#12345'));
	t.false(isValidStateColor('#zzzzzz'));
	t.false(isValidStateColor('74d09f'));
	t.false(isValidStateColor(''));
	t.false(isValidStateColor('  '));
	t.false(isValidStateColor(42));
	t.false(isValidStateColor(undefined));
	t.false(isValidStateColor(null));
});

test('ink color names are matched case-sensitively', t => {
	// Ink's own palette is camelCase; "BlueBright" is not a real key.
	t.false(isValidStateColor('BlueBright'));
	t.true(INK_COLOR_NAMES.has('blueBright'));
});

// ============================================================================
// lookupStateColorOverride — the pure lookup
// ============================================================================

test('lookupStateColorOverride returns null when there are no overrides', t => {
	t.is(lookupStateColorOverride(undefined, 'In Progress'), null);
	t.is(lookupStateColorOverride({}, 'In Progress'), null);
});

test('lookupStateColorOverride returns an exact-name match', t => {
	t.is(
		lookupStateColorOverride({'In Progress': '#f2c94c'}, 'In Progress'),
		'#f2c94c',
	);
});

test('lookupStateColorOverride matches case-insensitively', t => {
	const overrides = {'in progress': 'cyan'};
	t.is(lookupStateColorOverride(overrides, 'In Progress'), 'cyan');
	t.is(lookupStateColorOverride(overrides, 'IN PROGRESS'), 'cyan');
});

test('lookupStateColorOverride ignores surrounding whitespace', t => {
	t.is(
		lookupStateColorOverride({'  In Review  ': 'cyan'}, 'In Review'),
		'cyan',
	);
	t.is(lookupStateColorOverride({'In Review': 'cyan'}, ' In Review '), 'cyan');
});

test('lookupStateColorOverride returns null for an unlisted state', t => {
	t.is(lookupStateColorOverride({'In Progress': 'cyan'}, 'Done'), null);
});

test('lookupStateColorOverride returns null for a missing state name', t => {
	t.is(lookupStateColorOverride({'In Progress': 'cyan'}, undefined), null);
	t.is(lookupStateColorOverride({'In Progress': 'cyan'}, ''), null);
});

test('lookupStateColorOverride ignores invalid color values', t => {
	// Validation rejects these at load time, but the lookup is defensive so a
	// hand-edited cache or an unvalidated caller can never inject junk into Ink.
	t.is(lookupStateColorOverride({Done: 'chartreuse'}, 'Done'), null);
	t.is(lookupStateColorOverride({Done: ''}, 'Done'), null);
});

// ============================================================================
// Module singleton
// ============================================================================

test.serial('getStateColorOverride returns null before initialization', t => {
	resetStateColorOverrides();
	t.is(getStateColorOverride('In Progress'), null);
});

test.serial('initStateColorOverrides installs the map', t => {
	initStateColorOverrides({'In Review': 'cyan'});
	t.is(getStateColorOverride('in review'), 'cyan');
	t.is(getStateColorOverride('Done'), null);
	resetStateColorOverrides();
});

test.serial('initStateColorOverrides with undefined clears the map', t => {
	initStateColorOverrides({'In Review': 'cyan'});
	initStateColorOverrides(undefined);
	t.is(getStateColorOverride('In Review'), null);
	resetStateColorOverrides();
});

test.serial('resetStateColorOverrides clears the map', t => {
	initStateColorOverrides({Done: '#74d09f'});
	resetStateColorOverrides();
	t.is(getStateColorOverride('Done'), null);
});

// ============================================================================
// resolveStateColor — what the ticket rail calls
// ============================================================================

test.serial(
	'resolveStateColor returns the tracker color when nothing is configured',
	t => {
		resetStateColorOverrides();
		// The off-by-default regression: with no state_colors the rail is
		// byte-identical to master for every state.
		t.is(resolveStateColor('In Progress', '#f2c94c'), '#f2c94c');
		t.is(resolveStateColor('In Review', '#f2c94c'), '#f2c94c');
		t.is(resolveStateColor('Done', '#74d09f'), '#74d09f');
	},
);

test.serial('resolveStateColor returns the override when one matches', t => {
	initStateColorOverrides({'In Review': 'cyan'});
	t.is(resolveStateColor('In Review', '#f2c94c'), 'cyan');
	resetStateColorOverrides();
});

test.serial(
	'resolveStateColor falls back to the tracker color for unlisted states',
	t => {
		initStateColorOverrides({'In Review': 'cyan'});
		t.is(resolveStateColor('In Progress', '#f2c94c'), '#f2c94c');
		resetStateColorOverrides();
	},
);

test.serial(
	'resolveStateColor keeps the tracker color when the override is invalid',
	t => {
		initStateColorOverrides({Done: 'chartreuse'});
		t.is(resolveStateColor('Done', '#74d09f'), '#74d09f');
		resetStateColorOverrides();
	},
);
