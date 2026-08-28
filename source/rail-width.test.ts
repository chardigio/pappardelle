import test from 'ava';
import {nextRailWidthOverride, type RailResizeSample} from './rail-width.ts';
import {
	MIN_CLAUDE_WIDTH,
	MIN_COMPANION_WIDTH,
	MIN_LIST_WIDTH,
	MIN_RAIL_OVERRIDE_WIDTH,
	calculateLayoutForSize,
	clampRailWidth,
	maxRailOverrideWidth,
} from './layout-sizing.ts';

// ============================================================================
// Constants
// ============================================================================

test('manual rail floor is narrower than the derived floor', t => {
	t.is(MIN_RAIL_OVERRIDE_WIDTH, 8);
	t.true(MIN_LIST_WIDTH > MIN_RAIL_OVERRIDE_WIDTH);
});

// ============================================================================
// Clamping
// ============================================================================

test('clamp keeps a reasonable width unchanged', t => {
	t.is(clampRailWidth(12, 198, 86), 12);
});

test('clamp raises a too-narrow width to the manual floor', t => {
	t.is(clampRailWidth(2, 198, 86), MIN_RAIL_OVERRIDE_WIDTH);
	t.is(clampRailWidth(0, 198, 86), MIN_RAIL_OVERRIDE_WIDTH);
	t.is(clampRailWidth(-40, 198, 86), MIN_RAIL_OVERRIDE_WIDTH);
});

test('clamp floors a fractional width', t => {
	t.is(clampRailWidth(12.9, 198, 86), 12);
});

test('clamp leaves the claude pane its minimum', t => {
	// usable 198, companion 86 -> claude keeps 40, so the rail stops at 72.
	t.is(maxRailOverrideWidth(198, 86), 72);
	t.is(clampRailWidth(500, 198, 86), 72);
});

test('clamp never returns less than the manual floor even when squeezed', t => {
	// No room at all: the floor wins over the claude minimum.
	t.is(clampRailWidth(30, 50, 40), MIN_RAIL_OVERRIDE_WIDTH);
});

// ============================================================================
// Drag detection
// ============================================================================

const sample = (overrides: Partial<RailResizeSample>): RailResizeSample => ({
	previousWindow: {width: 200, height: 50},
	currentWindow: {width: 200, height: 50},
	previousRailWidth: 47,
	currentRailWidth: 47,
	currentOverride: null,
	...overrides,
});

test('same window + same rail = no override', t => {
	t.is(nextRailWidthOverride(sample({})), null);
});

test('same window + different rail = the dragged width becomes the override', t => {
	t.is(nextRailWidthOverride(sample({currentRailWidth: 12})), 12);
});

test('a widening drag is captured too', t => {
	t.is(nextRailWidthOverride(sample({currentRailWidth: 60})), 60);
});

test('a window resize is not read as a drag', t => {
	t.is(
		nextRailWidthOverride(
			sample({
				currentWindow: {width: 160, height: 50},
				currentRailWidth: 38,
			}),
		),
		null,
	);
});

test('a window height change is not read as a drag', t => {
	t.is(
		nextRailWidthOverride(
			sample({
				currentWindow: {width: 200, height: 40},
				currentRailWidth: 38,
			}),
		),
		null,
	);
});

test('an established override survives a window resize', t => {
	t.is(
		nextRailWidthOverride(
			sample({
				currentWindow: {width: 160, height: 50},
				currentRailWidth: 30,
				currentOverride: 12,
			}),
		),
		12,
	);
});

test('a second drag replaces the first override', t => {
	t.is(
		nextRailWidthOverride(
			sample({
				previousRailWidth: 12,
				currentRailWidth: 20,
				currentOverride: 12,
			}),
		),
		20,
	);
});

test('unknown window samples keep the current override', t => {
	t.is(
		nextRailWidthOverride(
			sample({previousWindow: null, currentRailWidth: 12, currentOverride: 30}),
		),
		30,
	);
	t.is(
		nextRailWidthOverride(
			sample({currentWindow: null, currentRailWidth: 12, currentOverride: 30}),
		),
		30,
	);
});

test('unknown rail samples keep the current override', t => {
	t.is(
		nextRailWidthOverride(
			sample({previousRailWidth: null, currentRailWidth: 12}),
		),
		null,
	);
	t.is(
		nextRailWidthOverride(
			sample({currentRailWidth: null, currentOverride: 12}),
		),
		12,
	);
});

// ============================================================================
// Layout integration
// ============================================================================

test('no override reproduces the master layout exactly', t => {
	for (const width of [100, 120, 160, 200, 300, 400]) {
		const base = calculateLayoutForSize(width, 50, 5);
		t.deepEqual(
			calculateLayoutForSize(width, 50, 5, null),
			base,
			`width ${width} with a null override must match master`,
		);
		t.deepEqual(
			calculateLayoutForSize(width, 50, 5, undefined),
			base,
			`width ${width} with an absent override must match master`,
		);
	}
});

test('an override sets the rail width and gives the columns to claude', t => {
	const base = calculateLayoutForSize(200, 50, 5);
	const dragged = calculateLayoutForSize(200, 50, 5, 12);

	t.is(dragged.listWidth, 12);
	t.is(dragged.companionWidth, base.companionWidth);
	t.is(
		dragged.claudeWidth,
		(base.claudeWidth ?? 0) + (base.listWidth ?? 0) - 12,
	);
	// The three panes plus two borders still fill the terminal.
	t.is(
		(dragged.listWidth ?? 0) +
			(dragged.claudeWidth ?? 0) +
			(dragged.companionWidth ?? 0),
		198,
	);
});

test('an override below the manual floor is clamped up', t => {
	t.is(
		calculateLayoutForSize(200, 50, 5, 1).listWidth,
		MIN_RAIL_OVERRIDE_WIDTH,
	);
});

test('an override may go below the derived floor', t => {
	const dragged = calculateLayoutForSize(200, 50, 5, 10);
	t.is(dragged.listWidth, 10);
	t.true(MIN_LIST_WIDTH > 10);
});

test('an override may go above the derived ceiling', t => {
	// MAX_LIST_WIDTH is 40; a drag past it is honored.
	const dragged = calculateLayoutForSize(300, 50, 5, 60);
	t.is(dragged.listWidth, 60);
});

test('an oversized override still leaves claude its minimum', t => {
	const dragged = calculateLayoutForSize(200, 50, 5, 500);
	t.true((dragged.claudeWidth ?? 0) >= MIN_CLAUDE_WIDTH);
	t.is(
		(dragged.listWidth ?? 0) +
			(dragged.claudeWidth ?? 0) +
			(dragged.companionWidth ?? 0),
		198,
	);
});

test('the override survives every wide terminal size', t => {
	for (const width of [110, 140, 200, 260, 400]) {
		const dragged = calculateLayoutForSize(width, 50, 5, 12);
		t.is(dragged.listWidth, 12, `width ${width}`);
		t.true((dragged.claudeWidth ?? 0) >= MIN_CLAUDE_WIDTH, `width ${width}`);
		t.is(
			(dragged.listWidth ?? 0) +
				(dragged.claudeWidth ?? 0) +
				(dragged.companionWidth ?? 0),
			width - 2,
			`width ${width}`,
		);
	}
});

test('the override is ignored in vertical layout', t => {
	const dragged = calculateLayoutForSize(80, 50, 5, 12);
	t.is(dragged.direction, 'vertical');
	t.is(dragged.listWidth, undefined);
	t.deepEqual(dragged, calculateLayoutForSize(80, 50, 5));
});

test('the override is honored at the narrowest horizontal terminal', t => {
	// 100 is NARROW_SCREEN_THRESHOLD, the first width that gets three columns.
	const cramped = calculateLayoutForSize(100, 50, 5, 12);
	t.is(cramped.direction, 'horizontal');
	t.is(cramped.listWidth, 12);
	t.true((cramped.claudeWidth ?? 0) >= MIN_CLAUDE_WIDTH);
	t.true((cramped.companionWidth ?? 0) >= MIN_COMPANION_WIDTH);
});

test('an oversized override on a narrow terminal falls back to the widest fit', t => {
	const cramped = calculateLayoutForSize(100, 50, 5, 500);
	t.is(
		cramped.listWidth,
		maxRailOverrideWidth(98, cramped.companionWidth ?? 0),
	);
	t.is(cramped.claudeWidth, MIN_CLAUDE_WIDTH);
});
