/**
 * Pure layout calculation functions for pappardelle pane sizing.
 *
 * These functions have no external dependencies (no tmux, no logging)
 * making them easy to unit test.
 */

// ============================================================================
// Layout Constants
// ============================================================================

/** Layout threshold: screens narrower than this use vertical stacking */
export const NARROW_SCREEN_THRESHOLD = 100;

/** Minimum pane widths (in characters) for horizontal layout */
export const MIN_LIST_WIDTH = 15;
export const MAX_LIST_WIDTH = 40;
export const MIN_CLAUDE_WIDTH = 40;
export const MIN_COMPANION_WIDTH = 20; // Companion can be squished but needs at least this much
export const MAX_COMPANION_WIDTH = 86; // 85 is the supposed breakpoint, but rounding errors sometimes cause vertical rendering at exactly 85, so we use 86 conservatively

/** Height constraints for vertical layout (in rows) */
export const MAX_LIST_HEIGHT = 14;
export const DEFAULT_MIN_LIST_HEIGHT = 8;
// The rail's header and status rows.
const LIST_CHROME_ROWS = 2;
// The top and bottom of the rail's frame (PaneFrame).
const PANE_FRAME_ROWS = 2;

/** Max fraction of usable height the list pane can take in vertical layout */
export const MAX_LIST_HEIGHT_RATIO = 0.25;

/**
 * Narrowest rail a hand-drag may produce.
 *
 * `MIN_LIST_WIDTH` (15) is the floor for the *derived* width, where a readable
 * title still matters. A deliberate drag has different intent: people shrink
 * the rail down to the issue key alone, so the manual floor is the width of an
 * icon plus a short key such as `STA-2040`. Below 8 the rail stops carrying
 * information at all. See STA-2040.
 */
export const MIN_RAIL_OVERRIDE_WIDTH = 8;

// ============================================================================
// Explicit Pane Widths
// ============================================================================

/**
 * A pane width set in config or by dragging a border: a column count, or a
 * share of the width the three panes split between them, such as `"25%"`.
 */
export type PaneWidth = number | `${number}%`;

/**
 * Widths that replace the derived ones in horizontal layout. `null` or absent
 * leaves that pane to the derived layout.
 */
export interface PaneWidths {
	rail?: PaneWidth | null;
	claude?: PaneWidth | null;
	companion?: PaneWidth | null;
}

export function isPaneWidth(value: unknown): value is PaneWidth {
	if (typeof value === 'number') return Number.isInteger(value) && value > 0;
	if (typeof value !== 'string') return false;
	const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
	if (!match) return false;
	const percent = Number(match[1]);
	return percent > 0 && percent <= 100;
}

export function resolvePaneWidth(
	width: PaneWidth,
	usableWidth: number,
): number {
	if (typeof width === 'number') return Math.floor(width);
	return Math.floor((usableWidth * Number.parseFloat(width)) / 100);
}

/**
 * Fit the two side panes around a claude pane of at least `MIN_CLAUDE_WIDTH`.
 *
 * When they do not fit, the rail gives up columns first, then the companion.
 * The floors win over the claude minimum when there is no room for all three.
 */
export function fitSidePanes(
	railWidth: number,
	companionWidth: number,
	usableWidth: number,
): {railWidth: number; companionWidth: number} {
	let rail = Math.max(MIN_RAIL_OVERRIDE_WIDTH, Math.floor(railWidth));
	let companion = Math.max(MIN_COMPANION_WIDTH, Math.floor(companionWidth));
	let excess = rail + companion + MIN_CLAUDE_WIDTH - usableWidth;
	if (excess > 0) {
		const fromRail = Math.min(excess, rail - MIN_RAIL_OVERRIDE_WIDTH);
		rail -= fromRail;
		excess -= fromRail;
		companion -= Math.min(excess, companion - MIN_COMPANION_WIDTH);
	}

	return {railWidth: rail, companionWidth: companion};
}

// ============================================================================
// Types
// ============================================================================

/**
 * Layout configuration returned by calculateLayoutForSize
 */
export interface LayoutConfig {
	direction: 'horizontal' | 'vertical';
	// For horizontal layout: widths
	listWidth?: number;
	agentWidth?: number;
	companionWidth?: number;
	// For vertical layout: heights
	listHeight?: number;
	agentHeight?: number;
}

// ============================================================================
// Pure Layout Calculation Functions
// ============================================================================

/**
 * Calculate the ideal list pane height based on session count.
 * This is a pure function for testability.
 *
 * @param sessionCount - Number of active Claude sessions
 * @param linesPerItem - Terminal rows each session takes (2 in two-line layout)
 * @returns Ideal height in rows for the list pane
 *
 * The pane holds every session plus the header and status rows, all
 * inside the rail's frame, then is clamped between min(ideal,
 * DEFAULT_MIN_LIST_HEIGHT) and MAX_LIST_HEIGHT.
 *
 * Note: calculateLayoutForSize applies an additional proportional cap
 * based on terminal height (MAX_LIST_HEIGHT_RATIO) so the list doesn't
 * dominate small screens.
 */
export function calculateIdealListHeightForCount(
	sessionCount: number,
	linesPerItem: 1 | 2 = 1,
): number {
	const idealHeight =
		Math.max(1, sessionCount) * linesPerItem +
		LIST_CHROME_ROWS +
		PANE_FRAME_ROWS;

	// Minimum is the smaller of ideal or default (don't force default num rows if we only need 4)
	const minHeight = Math.min(idealHeight, DEFAULT_MIN_LIST_HEIGHT);

	// Clamp between min and max
	return Math.max(minHeight, Math.min(idealHeight, MAX_LIST_HEIGHT));
}

/**
 * Calculate pane layout based on terminal dimensions.
 * This is a pure function for testability - accepts sessionCount as parameter.
 *
 * @param totalWidth - Total terminal width in characters
 * @param totalHeight - Total terminal height in rows
 * @param sessionCount - Number of active sessions (for vertical layout list height)
 * @param widths - Pane widths from config or a hand-drag that replace the
 *   derived ones. Only meaningful in horizontal layout.
 * @param linesPerItem - Terminal rows each session takes in the list
 * @returns LayoutConfig with direction and pane dimensions
 *
 * Layout modes:
 * - Narrow screens (< 100 chars): Vertical layout with list on top, agent below, no companion
 * - Wide screens (>= 100 chars): Horizontal layout [list] [claude] [companion]
 */
export function calculateLayoutForSize(
	totalWidth: number,
	totalHeight: number,
	sessionCount: number,
	widths: PaneWidths = {},
	linesPerItem: 1 | 2 = 1,
): LayoutConfig {
	// Narrow screen: use vertical layout
	if (totalWidth < NARROW_SCREEN_THRESHOLD) {
		// Account for tmux border (1 row), claude gets whatever's left
		const usableHeight = totalHeight - 1;

		// Cap list height proportionally so it doesn't dominate small screens
		const maxListForScreen = Math.max(
			3,
			Math.floor(usableHeight * MAX_LIST_HEIGHT_RATIO),
		);
		const listHeight = Math.min(
			calculateIdealListHeightForCount(sessionCount, linesPerItem),
			maxListForScreen,
		);
		const agentHeight = usableHeight - listHeight;

		return {
			direction: 'vertical',
			listHeight,
			agentHeight,
		};
	}

	// Wide screen: use horizontal layout
	// Account for tmux borders (2 chars per split = 2 borders between 3 panes)
	const usableWidth = totalWidth - 2;

	// Minimum total required
	const minTotal = MIN_LIST_WIDTH + MIN_CLAUDE_WIDTH + MIN_COMPANION_WIDTH;

	if (usableWidth <= minTotal) {
		// Very narrow: give each the minimum, companion may get nothing
		const remaining = usableWidth - MIN_LIST_WIDTH - MIN_CLAUDE_WIDTH;
		return {
			direction: 'horizontal',
			listWidth: MIN_LIST_WIDTH,
			agentWidth: MIN_CLAUDE_WIDTH,
			companionWidth: Math.max(0, remaining),
		};
	}

	// Target proportions: list ~24%, claude ~38%, companion ~38%
	// Calculate ideal widths as proportions of the total usable space,
	// but clamp between min/max constraints.
	let listWidth = Math.min(
		MAX_LIST_WIDTH,
		Math.max(MIN_LIST_WIDTH, Math.floor(usableWidth * 0.24)),
	);
	let agentWidth = Math.max(MIN_CLAUDE_WIDTH, Math.floor(usableWidth * 0.38));
	let companionWidth = usableWidth - listWidth - agentWidth;

	// Ensure companion doesn't go below minimum (give back from largest panes)
	if (companionWidth < MIN_COMPANION_WIDTH) {
		companionWidth = MIN_COMPANION_WIDTH;
		// Redistribute remaining between list and claude proportionally
		const remaining = usableWidth - companionWidth;
		listWidth = Math.min(
			MAX_LIST_WIDTH,
			Math.max(MIN_LIST_WIDTH, Math.floor((remaining * 0.24) / 0.62)),
		);
		agentWidth = remaining - listWidth;
	}

	// Cap companion at maximum, give excess to claude
	if (companionWidth > MAX_COMPANION_WIDTH) {
		const excess = companionWidth - MAX_COMPANION_WIDTH;
		companionWidth = MAX_COMPANION_WIDTH;
		agentWidth += excess;
	}

	const resolve = (width: PaneWidth | null | undefined) =>
		width === null || width === undefined
			? null
			: resolvePaneWidth(width, usableWidth);
	const rail = resolve(widths.rail);
	const companion = resolve(widths.companion);
	// Claude takes whatever the side panes leave, so its own width only decides
	// the layout when one of them is unset.
	const claude =
		rail !== null && companion !== null ? null : resolve(widths.claude);

	if (rail !== null || companion !== null || claude !== null) {
		let railTarget = rail ?? listWidth;
		let companionTarget = companion ?? companionWidth;
		if (claude !== null) {
			if (rail === null && companion !== null)
				railTarget = usableWidth - companion - claude;
			else companionTarget = usableWidth - railTarget - claude;
		}

		const fitted = fitSidePanes(railTarget, companionTarget, usableWidth);
		listWidth = fitted.railWidth;
		companionWidth = fitted.companionWidth;
		agentWidth = usableWidth - listWidth - companionWidth;
	}

	return {
		direction: 'horizontal',
		listWidth,
		agentWidth,
		companionWidth,
	};
}
