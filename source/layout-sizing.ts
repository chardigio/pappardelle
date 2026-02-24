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
export const MIN_LAZYGIT_WIDTH = 20; // Lazygit can be squished but needs at least this much
export const MAX_LAZYGIT_WIDTH = 60;

/** Height constraints for vertical layout (in rows) */
export const MAX_LIST_HEIGHT = 8;
export const DEFAULT_MIN_LIST_HEIGHT = 6;

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
	claudeWidth?: number;
	lazygitWidth?: number;
	// For vertical layout: heights
	listHeight?: number;
	claudeHeight?: number;
}

// ============================================================================
// Pure Layout Calculation Functions
// ============================================================================

/**
 * Calculate the ideal list pane height based on session count.
 * This is a pure function for testability.
 *
 * @param sessionCount - Number of active Claude sessions
 * @returns Ideal height in rows for the list pane
 *
 * Constraints:
 * - Minimum: min(ideal, 8) - give at least 8 rows, or ideal if smaller
 * - Maximum: 8 rows - don't let list take over the screen
 *
 * Examples:
 * - 0 sessions → height 3 (1+2 = 3, less than min 8, so use 3)
 * - 1 session  → height 3 (1+2 = 3, less than min 8, so use 3)
 * - 5 sessions → height 7 (5+2 = 7, less than min 8, so use 7)
 * - 6 sessions → height 8 (6+2 = 8, capped at max)
 * - 10 sessions → height 8 (10+2 = 12, capped at max 8)
 * - 15 sessions → height 8 (15+2 = 17, capped at max 8)
 */
export function calculateIdealListHeightForCount(sessionCount: number): number {
	// Ideal = sessions + header/padding (2 rows for chrome)
	const idealHeight = Math.max(1, sessionCount) + 2;

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
 * @returns LayoutConfig with direction and pane dimensions
 *
 * Layout modes:
 * - Narrow screens (< 100 chars): Vertical layout with list on top, claude below, no lazygit
 * - Wide screens (>= 100 chars): Horizontal layout [list] [claude] [lazygit]
 */
export function calculateLayoutForSize(
	totalWidth: number,
	totalHeight: number,
	sessionCount: number,
): LayoutConfig {
	// Narrow screen: use vertical layout
	if (totalWidth < NARROW_SCREEN_THRESHOLD) {
		const listHeight = calculateIdealListHeightForCount(sessionCount);

		// Account for tmux border (1 row), claude gets whatever's left
		const usableHeight = totalHeight - 1;
		const claudeHeight = usableHeight - listHeight;

		return {
			direction: 'vertical',
			listHeight,
			claudeHeight,
		};
	}

	// Wide screen: use horizontal layout
	// Account for tmux borders (2 chars per split = 2 borders between 3 panes)
	const usableWidth = totalWidth - 2;

	// Minimum total required
	const minTotal = MIN_LIST_WIDTH + MIN_CLAUDE_WIDTH + MIN_LAZYGIT_WIDTH;

	if (usableWidth <= minTotal) {
		// Very narrow: give each the minimum, lazygit may get nothing
		const remaining = usableWidth - MIN_LIST_WIDTH - MIN_CLAUDE_WIDTH;
		return {
			direction: 'horizontal',
			listWidth: MIN_LIST_WIDTH,
			claudeWidth: MIN_CLAUDE_WIDTH,
			lazygitWidth: Math.max(0, remaining),
		};
	}

	// Target proportions: list ~24%, claude ~38%, lazygit ~38%
	// Calculate ideal widths as proportions of the total usable space,
	// but clamp between min/max constraints.
	let listWidth = Math.min(
		MAX_LIST_WIDTH,
		Math.max(MIN_LIST_WIDTH, Math.floor(usableWidth * 0.24)),
	);
	let claudeWidth = Math.max(MIN_CLAUDE_WIDTH, Math.floor(usableWidth * 0.38));
	let lazygitWidth = usableWidth - listWidth - claudeWidth;

	// Ensure lazygit doesn't go below minimum (give back from largest panes)
	if (lazygitWidth < MIN_LAZYGIT_WIDTH) {
		lazygitWidth = MIN_LAZYGIT_WIDTH;
		// Redistribute remaining between list and claude proportionally
		const remaining = usableWidth - lazygitWidth;
		listWidth = Math.min(
			MAX_LIST_WIDTH,
			Math.max(MIN_LIST_WIDTH, Math.floor((remaining * 0.24) / 0.62)),
		);
		claudeWidth = remaining - listWidth;
	}

	// Cap lazygit at maximum, give excess to claude
	if (lazygitWidth > MAX_LAZYGIT_WIDTH) {
		const excess = lazygitWidth - MAX_LAZYGIT_WIDTH;
		lazygitWidth = MAX_LAZYGIT_WIDTH;
		claudeWidth += excess;
	}

	return {
		direction: 'horizontal',
		listWidth,
		claudeWidth,
		lazygitWidth,
	};
}
