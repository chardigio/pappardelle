import {test, expect} from 'bun:test';
import {
	ANSI_COLOR_NAMES,
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

test('isValidStateColor accepts 6-digit hex', () => {
	expect(isValidStateColor('#74d09f')).toBe(true);
	expect(isValidStateColor('#FFFFFF')).toBe(true);
});

test('isValidStateColor accepts 3-digit hex', () => {
	expect(isValidStateColor('#abc')).toBe(true);
});

test('isValidStateColor accepts ANSI color names', () => {
	expect(isValidStateColor('cyan')).toBe(true);
	expect(isValidStateColor('magenta')).toBe(true);
	expect(isValidStateColor('blueBright')).toBe(true);
	expect(isValidStateColor('gray')).toBe(true);
	expect(isValidStateColor('grey')).toBe(true);
});

test('isValidStateColor rejects unknown names and malformed hex', () => {
	expect(isValidStateColor('chartreuse')).toBe(false);
	expect(isValidStateColor('#12345')).toBe(false);
	expect(isValidStateColor('#zzzzzz')).toBe(false);
	expect(isValidStateColor('74d09f')).toBe(false);
	expect(isValidStateColor('')).toBe(false);
	expect(isValidStateColor('  ')).toBe(false);
	expect(isValidStateColor(42)).toBe(false);
	expect(isValidStateColor(undefined)).toBe(false);
	expect(isValidStateColor(null)).toBe(false);
});

test('ANSI color names are matched case-sensitively', () => {
	// terminalColor's palette keys are camelCase; "BlueBright" is not one.
	expect(isValidStateColor('BlueBright')).toBe(false);
	expect(ANSI_COLOR_NAMES.has('blueBright')).toBe(true);
});

// ============================================================================
// lookupStateColorOverride — the pure lookup
// ============================================================================

test('lookupStateColorOverride returns null when there are no overrides', () => {
	expect(lookupStateColorOverride(undefined, 'In Progress')).toBe(null);
	expect(lookupStateColorOverride({}, 'In Progress')).toBe(null);
});

test('lookupStateColorOverride returns an exact-name match', () => {
	expect(
		lookupStateColorOverride({'In Progress': '#f2c94c'}, 'In Progress'),
	).toBe('#f2c94c');
});

test('lookupStateColorOverride matches case-insensitively', () => {
	const overrides = {'in progress': 'cyan'};
	expect(lookupStateColorOverride(overrides, 'In Progress')).toBe('cyan');
	expect(lookupStateColorOverride(overrides, 'IN PROGRESS')).toBe('cyan');
});

test('lookupStateColorOverride ignores surrounding whitespace', () => {
	expect(lookupStateColorOverride({'  In Review  ': 'cyan'}, 'In Review')).toBe(
		'cyan',
	);
	expect(lookupStateColorOverride({'In Review': 'cyan'}, ' In Review ')).toBe(
		'cyan',
	);
});

test('lookupStateColorOverride returns null for an unlisted state', () => {
	expect(lookupStateColorOverride({'In Progress': 'cyan'}, 'Done')).toBe(null);
});

test('lookupStateColorOverride returns null for a missing state name', () => {
	expect(lookupStateColorOverride({'In Progress': 'cyan'}, undefined)).toBe(
		null,
	);
	expect(lookupStateColorOverride({'In Progress': 'cyan'}, '')).toBe(null);
});

test('lookupStateColorOverride ignores invalid color values', () => {
	// Validation rejects these at load time, but the lookup is defensive so a
	// hand-edited cache or an unvalidated caller can never reach the renderer.
	expect(lookupStateColorOverride({Done: 'chartreuse'}, 'Done')).toBe(null);
	expect(lookupStateColorOverride({Done: ''}, 'Done')).toBe(null);
});

// ============================================================================
// Module singleton
// ============================================================================

test('getStateColorOverride returns null before initialization', () => {
	resetStateColorOverrides();
	expect(getStateColorOverride('In Progress')).toBe(null);
});

test('initStateColorOverrides installs the map', () => {
	initStateColorOverrides({'In Review': 'cyan'});
	expect(getStateColorOverride('in review')).toBe('cyan');
	expect(getStateColorOverride('Done')).toBe(null);
	resetStateColorOverrides();
});

test('initStateColorOverrides with undefined clears the map', () => {
	initStateColorOverrides({'In Review': 'cyan'});
	initStateColorOverrides(undefined);
	expect(getStateColorOverride('In Review')).toBe(null);
	resetStateColorOverrides();
});

test('resetStateColorOverrides clears the map', () => {
	initStateColorOverrides({Done: '#74d09f'});
	resetStateColorOverrides();
	expect(getStateColorOverride('Done')).toBe(null);
});

// ============================================================================
// resolveStateColor — what the ticket rail calls
// ============================================================================

test('resolveStateColor returns the tracker color when nothing is configured', () => {
	resetStateColorOverrides();
	expect(resolveStateColor('In Progress', '#f2c94c')).toBe('#f2c94c');
	expect(resolveStateColor('Done', '#74d09f')).toBe('#74d09f');
});

test('resolveStateColor paints In Review purple on any tracker by default', () => {
	resetStateColorOverrides();
	expect(resolveStateColor('In Review', '#4b9fea')).toBe('#a78bfa');
	expect(resolveStateColor(' in review ', '#f2c94c')).toBe('#a78bfa');
});

test('resolveStateColor returns the override when one matches', () => {
	initStateColorOverrides({'In Review': 'cyan'});
	expect(resolveStateColor('In Review', '#f2c94c')).toBe('cyan');
	resetStateColorOverrides();
});

test('resolveStateColor falls back to the tracker color for unlisted states', () => {
	initStateColorOverrides({'In Review': 'cyan'});
	expect(resolveStateColor('In Progress', '#f2c94c')).toBe('#f2c94c');
	resetStateColorOverrides();
});

test('resolveStateColor keeps the tracker color when the override is invalid', () => {
	initStateColorOverrides({Done: 'chartreuse'});
	expect(resolveStateColor('Done', '#74d09f')).toBe('#74d09f');
	resetStateColorOverrides();
});
