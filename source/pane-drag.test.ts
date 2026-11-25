import {test, expect} from 'bun:test';
import {nextSizeOverride, type PaneResizeSample} from './pane-drag.ts';
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

test('manual rail floor is narrower than the derived floor', () => {
	expect(MIN_RAIL_OVERRIDE_WIDTH).toBe(8);
	expect(MIN_LIST_WIDTH > MIN_RAIL_OVERRIDE_WIDTH).toBe(true);
});

// ============================================================================
// Clamping
// ============================================================================

const fit = (rail: number, companion: number, usable: number) =>
	fitSidePanes(rail, companion, usable);

test('fit keeps widths that leave claude its minimum', () => {
	expect(fit(12, 86, 198)).toStrictEqual({railWidth: 12, companionWidth: 86});
});

test('fit raises side panes to their floors', () => {
	expect(fit(2, 5, 198)).toStrictEqual({
		railWidth: MIN_RAIL_OVERRIDE_WIDTH,
		companionWidth: MIN_COMPANION_WIDTH,
	});
	expect(fit(-40, 86, 198).railWidth).toBe(MIN_RAIL_OVERRIDE_WIDTH);
});

test('fit floors fractional widths', () => {
	expect(fit(12.9, 50.5, 198)).toStrictEqual({
		railWidth: 12,
		companionWidth: 50,
	});
});

test('fit takes columns from the rail before the companion', () => {
	// usable 198, companion 86 -> claude keeps 40, so the rail stops at 72.
	expect(fit(500, 86, 198)).toStrictEqual({railWidth: 72, companionWidth: 86});
});

test('fit takes from the companion once the rail is at its floor', () => {
	// 198 - 8 - 40 = 150 left for the companion.
	expect(fit(8, 300, 198)).toStrictEqual({railWidth: 8, companionWidth: 150});
});

test('fit lets the floors win when nothing fits', () => {
	expect(fit(30, 40, 50)).toStrictEqual({
		railWidth: MIN_RAIL_OVERRIDE_WIDTH,
		companionWidth: MIN_COMPANION_WIDTH,
	});
});

test('percent widths are a share of the usable width', () => {
	expect(resolvePaneWidth('10%', 198)).toBe(19);
	expect(resolvePaneWidth('45%', 198)).toBe(89);
	expect(resolvePaneWidth('12.5%', 200)).toBe(25);
	expect(resolvePaneWidth(30, 198)).toBe(30);
});

// ============================================================================
// Drag detection
// ============================================================================

const sample = (overrides: Partial<PaneResizeSample>): PaneResizeSample => ({
	previousWindow: {width: 200, height: 50},
	currentWindow: {width: 200, height: 50},
	previousSize: 47,
	currentSize: 47,
	currentOverride: null,
	...overrides,
});

test('same window + same rail = no override', () => {
	expect(nextSizeOverride(sample({}))).toBe(null);
});

test('same window + different rail = the dragged width becomes the override', () => {
	expect(nextSizeOverride(sample({currentSize: 12}))).toBe(12);
});

test('a widening drag is captured too', () => {
	expect(nextSizeOverride(sample({currentSize: 60}))).toBe(60);
});

test('a window resize is not read as a drag', () => {
	expect(
		nextSizeOverride(
			sample({
				currentWindow: {width: 160, height: 50},
				currentSize: 38,
			}),
		),
	).toBe(null);
});

test('a window height change is not read as a drag', () => {
	expect(
		nextSizeOverride(
			sample({
				currentWindow: {width: 200, height: 40},
				currentSize: 38,
			}),
		),
	).toBe(null);
});

test('an established override survives a window resize', () => {
	expect(
		nextSizeOverride(
			sample({
				currentWindow: {width: 160, height: 50},
				currentSize: 30,
				currentOverride: 12,
			}),
		),
	).toBe(12);
});

test('a second drag replaces the first override', () => {
	expect(
		nextSizeOverride(
			sample({
				previousSize: 12,
				currentSize: 20,
				currentOverride: 12,
			}),
		),
	).toBe(20);
});

test('unknown window samples keep the current override', () => {
	expect(
		nextSizeOverride(
			sample({previousWindow: null, currentSize: 12, currentOverride: 30}),
		),
	).toBe(30);
	expect(
		nextSizeOverride(
			sample({currentWindow: null, currentSize: 12, currentOverride: 30}),
		),
	).toBe(30);
});

test('unknown width samples keep the current override', () => {
	expect(nextSizeOverride(sample({previousSize: null, currentSize: 12}))).toBe(
		null,
	);
	expect(
		nextSizeOverride(sample({currentSize: null, currentOverride: 12})),
	).toBe(12);
});

// ============================================================================
// Layout integration
// ============================================================================

test('no override reproduces the master layout exactly', () => {
	for (const width of [100, 120, 160, 200, 300, 400]) {
		const base = calculateLayoutForSize(width, 50, 5);
		expect(
			calculateLayoutForSize(width, 50, 5, {rail: null, companion: null}),
			`width ${width} with null widths must match master`,
		).toStrictEqual(base);
		expect(
			calculateLayoutForSize(width, 50, 5, {}),
			`width ${width} with absent widths must match master`,
		).toStrictEqual(base);
	}
});

test('an override sets the rail width and gives the columns to claude', () => {
	const base = calculateLayoutForSize(200, 50, 5);
	const dragged = calculateLayoutForSize(200, 50, 5, {rail: 12});

	expect(dragged.listWidth).toBe(12);
	expect(dragged.companionWidth).toBe(base.companionWidth);
	expect(dragged.agentWidth).toBe(
		(base.agentWidth ?? 0) + (base.listWidth ?? 0) - 12,
	);
	// The three panes plus two borders still fill the terminal.
	expect(
		(dragged.listWidth ?? 0) +
			(dragged.agentWidth ?? 0) +
			(dragged.companionWidth ?? 0),
	).toBe(198);
});

test('an override below the manual floor is clamped up', () => {
	expect(calculateLayoutForSize(200, 50, 5, {rail: 1}).listWidth).toBe(
		MIN_RAIL_OVERRIDE_WIDTH,
	);
});

test('an override may go below the derived floor', () => {
	const dragged = calculateLayoutForSize(200, 50, 5, {rail: 10});
	expect(dragged.listWidth).toBe(10);
	expect(MIN_LIST_WIDTH > 10).toBe(true);
});

test('an override may go above the derived ceiling', () => {
	// MAX_LIST_WIDTH is 40; a drag past it is honored.
	const dragged = calculateLayoutForSize(300, 50, 5, {rail: 60});
	expect(dragged.listWidth).toBe(60);
});

test('an oversized override still leaves claude its minimum', () => {
	const dragged = calculateLayoutForSize(200, 50, 5, {rail: 500});
	expect((dragged.agentWidth ?? 0) >= MIN_CLAUDE_WIDTH).toBe(true);
	expect(
		(dragged.listWidth ?? 0) +
			(dragged.agentWidth ?? 0) +
			(dragged.companionWidth ?? 0),
	).toBe(198);
});

test('the override survives every wide terminal size', () => {
	for (const width of [110, 140, 200, 260, 400]) {
		const dragged = calculateLayoutForSize(width, 50, 5, {rail: 12});
		expect(dragged.listWidth, `width ${width}`).toBe(12);
		expect(
			(dragged.agentWidth ?? 0) >= MIN_CLAUDE_WIDTH,
			`width ${width}`,
		).toBe(true);
		expect(
			(dragged.listWidth ?? 0) +
				(dragged.agentWidth ?? 0) +
				(dragged.companionWidth ?? 0),
			`width ${width}`,
		).toBe(width - 2);
	}
});

test('the override is ignored in vertical layout', () => {
	const dragged = calculateLayoutForSize(80, 50, 5, {rail: 12});
	expect(dragged.direction).toBe('vertical');
	expect(dragged.listWidth).toBe(undefined);
	expect(dragged).toStrictEqual(calculateLayoutForSize(80, 50, 5));
});

test('the override is honored at the narrowest horizontal terminal', () => {
	// 90 is NARROW_SCREEN_THRESHOLD, the first width that gets three columns.
	const cramped = calculateLayoutForSize(90, 50, 5, {rail: 12});
	expect(cramped.direction).toBe('horizontal');
	expect(cramped.listWidth).toBe(12);
	expect((cramped.agentWidth ?? 0) >= MIN_CLAUDE_WIDTH).toBe(true);
	expect((cramped.companionWidth ?? 0) >= MIN_COMPANION_WIDTH).toBe(true);
});

test('an oversized override on a narrow terminal falls back to the widest fit', () => {
	const cramped = calculateLayoutForSize(90, 50, 5, {rail: 500});
	expect(cramped.listWidth).toBe(
		88 - (cramped.companionWidth ?? 0) - MIN_CLAUDE_WIDTH,
	);
	expect(cramped.agentWidth).toBe(MIN_CLAUDE_WIDTH);
});

const total = (layout: ReturnType<typeof calculateLayoutForSize>) =>
	(layout.listWidth ?? 0) +
	(layout.agentWidth ?? 0) +
	(layout.companionWidth ?? 0);

test('a companion width replaces the derived one and claude absorbs the difference', () => {
	const base = calculateLayoutForSize(200, 50, 5);
	const dragged = calculateLayoutForSize(200, 50, 5, {companion: 60});
	expect(dragged.companionWidth).toBe(60);
	expect(dragged.listWidth).toBe(base.listWidth);
	expect(total(dragged)).toBe(198);
});

test('a companion width may go past the derived cap', () => {
	// MAX_COMPANION_WIDTH is 86.
	expect(
		calculateLayoutForSize(300, 50, 5, {companion: 150}).companionWidth,
	).toBe(150);
});

test('a companion width below its floor is clamped up', () => {
	expect(
		calculateLayoutForSize(200, 50, 5, {companion: 3}).companionWidth,
	).toBe(MIN_COMPANION_WIDTH);
});

test('an oversized companion width leaves claude its minimum', () => {
	const layout = calculateLayoutForSize(200, 50, 5, {companion: 500});
	expect(layout.agentWidth).toBe(MIN_CLAUDE_WIDTH);
	expect(total(layout)).toBe(198);
});

test('10/45/45 percentages split the usable width', () => {
	const layout = calculateLayoutForSize(200, 50, 5, {
		rail: '10%',
		claude: '45%',
		companion: '45%',
	});
	expect(layout.listWidth).toBe(19);
	expect(layout.companionWidth).toBe(89);
	expect(layout.agentWidth).toBe(90);
});

test('claude takes the remainder when both side panes are set', () => {
	const layout = calculateLayoutForSize(200, 50, 5, {
		rail: 20,
		claude: 10,
		companion: 60,
	});
	expect([
		layout.listWidth,
		layout.agentWidth,
		layout.companionWidth,
	]).toStrictEqual([20, 118, 60]);
});

test('a claude width with the rail set sizes the companion', () => {
	const layout = calculateLayoutForSize(200, 50, 5, {rail: 20, claude: 100});
	expect([
		layout.listWidth,
		layout.agentWidth,
		layout.companionWidth,
	]).toStrictEqual([20, 100, 78]);
});

test('a claude width with the companion set sizes the rail', () => {
	const layout = calculateLayoutForSize(200, 50, 5, {
		claude: 100,
		companion: 70,
	});
	expect([
		layout.listWidth,
		layout.agentWidth,
		layout.companionWidth,
	]).toStrictEqual([28, 100, 70]);
});

test('a claude width alone keeps the derived rail and sizes the companion', () => {
	const base = calculateLayoutForSize(200, 50, 5);
	const layout = calculateLayoutForSize(200, 50, 5, {claude: '60%'});
	expect(layout.listWidth).toBe(base.listWidth);
	expect(layout.agentWidth).toBe(118);
	expect(total(layout)).toBe(198);
});

test('a claude width too wide for the terminal keeps the companion floor', () => {
	const layout = calculateLayoutForSize(200, 50, 5, {claude: 500});
	expect(layout.companionWidth).toBe(MIN_COMPANION_WIDTH);
	expect(total(layout)).toBe(198);
});

test('widths are ignored in vertical layout', () => {
	expect(
		calculateLayoutForSize(80, 50, 5, {rail: 10, claude: 30, companion: 30}),
	).toStrictEqual(calculateLayoutForSize(80, 50, 5));
});
