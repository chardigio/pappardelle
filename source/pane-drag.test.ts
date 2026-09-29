import test from 'ava';
import {nextWidthOverride, type PaneResizeSample} from './pane-drag.ts';
import {
	MIN_CLAUDE_WIDTH,
	MIN_COMPANION_WIDTH,
	MIN_LIST_WIDTH,
	MIN_RAIL_OVERRIDE_WIDTH,
	calculateLayoutForSize,
	fitSidePanes,
	resolvePaneWidth,
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

const fit = (rail: number, companion: number, usable: number) =>
	fitSidePanes(rail, companion, usable);

test('fit keeps widths that leave claude its minimum', t => {
	t.deepEqual(fit(12, 86, 198), {railWidth: 12, companionWidth: 86});
});

test('fit raises side panes to their floors', t => {
	t.deepEqual(fit(2, 5, 198), {
		railWidth: MIN_RAIL_OVERRIDE_WIDTH,
		companionWidth: MIN_COMPANION_WIDTH,
	});
	t.is(fit(-40, 86, 198).railWidth, MIN_RAIL_OVERRIDE_WIDTH);
});

test('fit floors fractional widths', t => {
	t.deepEqual(fit(12.9, 50.5, 198), {railWidth: 12, companionWidth: 50});
});

test('fit takes columns from the rail before the companion', t => {
	// usable 198, companion 86 -> claude keeps 40, so the rail stops at 72.
	t.deepEqual(fit(500, 86, 198), {railWidth: 72, companionWidth: 86});
});

test('fit takes from the companion once the rail is at its floor', t => {
	// 198 - 8 - 40 = 150 left for the companion.
	t.deepEqual(fit(8, 300, 198), {railWidth: 8, companionWidth: 150});
});

test('fit lets the floors win when nothing fits', t => {
	t.deepEqual(fit(30, 40, 50), {
		railWidth: MIN_RAIL_OVERRIDE_WIDTH,
		companionWidth: MIN_COMPANION_WIDTH,
	});
});

test('percent widths are a share of the usable width', t => {
	t.is(resolvePaneWidth('10%', 198), 19);
	t.is(resolvePaneWidth('45%', 198), 89);
	t.is(resolvePaneWidth('12.5%', 200), 25);
	t.is(resolvePaneWidth(30, 198), 30);
});

// ============================================================================
// Drag detection
// ============================================================================

const sample = (overrides: Partial<PaneResizeSample>): PaneResizeSample => ({
	previousWindow: {width: 200, height: 50},
	currentWindow: {width: 200, height: 50},
	previousWidth: 47,
	currentWidth: 47,
	currentOverride: null,
	...overrides,
});

test('same window + same rail = no override', t => {
	t.is(nextWidthOverride(sample({})), null);
});

test('same window + different rail = the dragged width becomes the override', t => {
	t.is(nextWidthOverride(sample({currentWidth: 12})), 12);
});

test('a widening drag is captured too', t => {
	t.is(nextWidthOverride(sample({currentWidth: 60})), 60);
});

test('a window resize is not read as a drag', t => {
	t.is(
		nextWidthOverride(
			sample({
				currentWindow: {width: 160, height: 50},
				currentWidth: 38,
			}),
		),
		null,
	);
});

test('a window height change is not read as a drag', t => {
	t.is(
		nextWidthOverride(
			sample({
				currentWindow: {width: 200, height: 40},
				currentWidth: 38,
			}),
		),
		null,
	);
});

test('an established override survives a window resize', t => {
	t.is(
		nextWidthOverride(
			sample({
				currentWindow: {width: 160, height: 50},
				currentWidth: 30,
				currentOverride: 12,
			}),
		),
		12,
	);
});

test('a second drag replaces the first override', t => {
	t.is(
		nextWidthOverride(
			sample({
				previousWidth: 12,
				currentWidth: 20,
				currentOverride: 12,
			}),
		),
		20,
	);
});

test('unknown window samples keep the current override', t => {
	t.is(
		nextWidthOverride(
			sample({previousWindow: null, currentWidth: 12, currentOverride: 30}),
		),
		30,
	);
	t.is(
		nextWidthOverride(
			sample({currentWindow: null, currentWidth: 12, currentOverride: 30}),
		),
		30,
	);
});

test('unknown width samples keep the current override', t => {
	t.is(
		nextWidthOverride(sample({previousWidth: null, currentWidth: 12})),
		null,
	);
	t.is(
		nextWidthOverride(sample({currentWidth: null, currentOverride: 12})),
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
			calculateLayoutForSize(width, 50, 5, {rail: null, companion: null}),
			base,
			`width ${width} with null widths must match master`,
		);
		t.deepEqual(
			calculateLayoutForSize(width, 50, 5, {}),
			base,
			`width ${width} with absent widths must match master`,
		);
	}
});

test('an override sets the rail width and gives the columns to claude', t => {
	const base = calculateLayoutForSize(200, 50, 5);
	const dragged = calculateLayoutForSize(200, 50, 5, {rail: 12});

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
		calculateLayoutForSize(200, 50, 5, {rail: 1}).listWidth,
		MIN_RAIL_OVERRIDE_WIDTH,
	);
});

test('an override may go below the derived floor', t => {
	const dragged = calculateLayoutForSize(200, 50, 5, {rail: 10});
	t.is(dragged.listWidth, 10);
	t.true(MIN_LIST_WIDTH > 10);
});

test('an override may go above the derived ceiling', t => {
	// MAX_LIST_WIDTH is 40; a drag past it is honored.
	const dragged = calculateLayoutForSize(300, 50, 5, {rail: 60});
	t.is(dragged.listWidth, 60);
});

test('an oversized override still leaves claude its minimum', t => {
	const dragged = calculateLayoutForSize(200, 50, 5, {rail: 500});
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
		const dragged = calculateLayoutForSize(width, 50, 5, {rail: 12});
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
	const dragged = calculateLayoutForSize(80, 50, 5, {rail: 12});
	t.is(dragged.direction, 'vertical');
	t.is(dragged.listWidth, undefined);
	t.deepEqual(dragged, calculateLayoutForSize(80, 50, 5));
});

test('the override is honored at the narrowest horizontal terminal', t => {
	// 100 is NARROW_SCREEN_THRESHOLD, the first width that gets three columns.
	const cramped = calculateLayoutForSize(100, 50, 5, {rail: 12});
	t.is(cramped.direction, 'horizontal');
	t.is(cramped.listWidth, 12);
	t.true((cramped.claudeWidth ?? 0) >= MIN_CLAUDE_WIDTH);
	t.true((cramped.companionWidth ?? 0) >= MIN_COMPANION_WIDTH);
});

test('an oversized override on a narrow terminal falls back to the widest fit', t => {
	const cramped = calculateLayoutForSize(100, 50, 5, {rail: 500});
	t.is(
		cramped.listWidth,
		98 - (cramped.companionWidth ?? 0) - MIN_CLAUDE_WIDTH,
	);
	t.is(cramped.claudeWidth, MIN_CLAUDE_WIDTH);
});

const total = (layout: ReturnType<typeof calculateLayoutForSize>) =>
	(layout.listWidth ?? 0) +
	(layout.claudeWidth ?? 0) +
	(layout.companionWidth ?? 0);

test('a companion width replaces the derived one and claude absorbs the difference', t => {
	const base = calculateLayoutForSize(200, 50, 5);
	const dragged = calculateLayoutForSize(200, 50, 5, {companion: 60});
	t.is(dragged.companionWidth, 60);
	t.is(dragged.listWidth, base.listWidth);
	t.is(total(dragged), 198);
});

test('a companion width may go past the derived cap', t => {
	// MAX_COMPANION_WIDTH is 86.
	t.is(
		calculateLayoutForSize(300, 50, 5, {companion: 150}).companionWidth,
		150,
	);
});

test('a companion width below its floor is clamped up', t => {
	t.is(
		calculateLayoutForSize(200, 50, 5, {companion: 3}).companionWidth,
		MIN_COMPANION_WIDTH,
	);
});

test('an oversized companion width leaves claude its minimum', t => {
	const layout = calculateLayoutForSize(200, 50, 5, {companion: 500});
	t.is(layout.claudeWidth, MIN_CLAUDE_WIDTH);
	t.is(total(layout), 198);
});

test('10/45/45 percentages split the usable width', t => {
	const layout = calculateLayoutForSize(200, 50, 5, {
		rail: '10%',
		claude: '45%',
		companion: '45%',
	});
	t.is(layout.listWidth, 19);
	t.is(layout.companionWidth, 89);
	t.is(layout.claudeWidth, 90);
});

test('claude takes the remainder when both side panes are set', t => {
	const layout = calculateLayoutForSize(200, 50, 5, {
		rail: 20,
		claude: 10,
		companion: 60,
	});
	t.deepEqual(
		[layout.listWidth, layout.claudeWidth, layout.companionWidth],
		[20, 118, 60],
	);
});

test('a claude width with the rail set sizes the companion', t => {
	const layout = calculateLayoutForSize(200, 50, 5, {rail: 20, claude: 100});
	t.deepEqual(
		[layout.listWidth, layout.claudeWidth, layout.companionWidth],
		[20, 100, 78],
	);
});

test('a claude width with the companion set sizes the rail', t => {
	const layout = calculateLayoutForSize(200, 50, 5, {
		claude: 100,
		companion: 70,
	});
	t.deepEqual(
		[layout.listWidth, layout.claudeWidth, layout.companionWidth],
		[28, 100, 70],
	);
});

test('a claude width alone keeps the derived rail and sizes the companion', t => {
	const base = calculateLayoutForSize(200, 50, 5);
	const layout = calculateLayoutForSize(200, 50, 5, {claude: '60%'});
	t.is(layout.listWidth, base.listWidth);
	t.is(layout.claudeWidth, 118);
	t.is(total(layout), 198);
});

test('a claude width too wide for the terminal keeps the companion floor', t => {
	const layout = calculateLayoutForSize(200, 50, 5, {claude: 500});
	t.is(layout.companionWidth, MIN_COMPANION_WIDTH);
	t.is(total(layout), 198);
});

test('widths are ignored in vertical layout', t => {
	t.deepEqual(
		calculateLayoutForSize(80, 50, 5, {rail: 10, claude: 30, companion: 30}),
		calculateLayoutForSize(80, 50, 5),
	);
});
