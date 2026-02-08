/**
 * Pure list-view calculation functions for pappardelle.
 *
 * These functions compute which items are visible in the list pane,
 * scroll offsets, and per-row layout (issue key padding, title truncation).
 * No external dependencies — easy to unit test with ASCII art assertions.
 */

// ============================================================================
// Constants
// ============================================================================

/** Rows consumed by header (1 line) + header marginBottom (1 line) = 2 */
export const HEADER_ROWS = 2;

/** Total non-item chrome (header only, no footer) */
export const LIST_CHROME_ROWS = HEADER_ROWS;

/** Fixed-width characters per row (excluding issue key): icon(1) + space(1) + space(1) = 3 */
export const ROW_FIXED_OVERHEAD = 3;

// ============================================================================
// Scrolling / visibility
// ============================================================================

/**
 * Calculate how many list items can be displayed given the terminal height.
 *
 * @param termHeight - Height of the list pane in rows
 * @returns Maximum number of items that fit
 */
export function calculateMaxVisibleItems(termHeight: number): number {
	return Math.max(1, termHeight - LIST_CHROME_ROWS);
}

/**
 * Calculate the scroll offset so the selected item stays centred.
 *
 * @param selectedIndex - Currently selected item index (0-based)
 * @param totalItems - Total number of items in the list
 * @param maxVisible - Maximum items that fit on screen
 * @returns Offset into the items array for the first visible item
 */
export function calculateScrollOffset(
	selectedIndex: number,
	totalItems: number,
	maxVisible: number,
): number {
	return Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(maxVisible / 2),
			totalItems - maxVisible,
		),
	);
}

/**
 * Determine the visible window of items and the adjusted selection index.
 *
 * @returns Object with visibleRange [start, end), adjustedSelectedIndex
 */
export function calculateVisibleWindow(
	selectedIndex: number,
	totalItems: number,
	termHeight: number,
): {
	scrollOffset: number;
	visibleCount: number;
	adjustedSelectedIndex: number;
} {
	const maxVisible = calculateMaxVisibleItems(termHeight);
	const scrollOffset = calculateScrollOffset(
		selectedIndex,
		totalItems,
		maxVisible,
	);
	const visibleCount = Math.min(maxVisible, totalItems - scrollOffset);
	const adjustedSelectedIndex = selectedIndex - scrollOffset;

	return {scrollOffset, visibleCount, adjustedSelectedIndex};
}

// ============================================================================
// Row rendering
// ============================================================================

/**
 * Calculate available width for the title text in a list row.
 *
 * Row format: "icon space issueKey space title"
 * Fixed overhead = icon(1) + space(1) + space(1) = 3
 * Total fixed = 3 + issueKey.length
 *
 * @param totalWidth - Total width of the list pane in characters
 * @param issueKeyLength - Length of the issue key string (e.g. 7 for "STA-452")
 * @returns Number of characters available for the title
 */
export function calculateAvailableTitleWidth(
	totalWidth: number,
	issueKeyLength: number,
): number {
	return Math.max(0, totalWidth - ROW_FIXED_OVERHEAD - issueKeyLength);
}

/**
 * Truncate a title to fit within the available width.
 *
 * @param title - Full title text
 * @param availableWidth - Characters available
 * @returns Truncated title (with ellipsis if needed)
 */
export function truncateTitle(title: string, availableWidth: number): string {
	if (availableWidth <= 0) return '';
	if (title.length <= availableWidth) return title;
	return title.slice(0, availableWidth - 1) + '\u2026';
}

/**
 * Render a simplified ASCII representation of a single list row.
 * Matches the SpaceListItem layout: icon first, then issue key, then title.
 * Selection is shown via inverse background in the real UI, not in ASCII.
 *
 * Format: "· STA-452 Fix the bu…"
 *
 * @param issueKey - e.g. "STA-452"
 * @param icon - status icon character (e.g. "?", "·", "!")
 * @param title - issue title
 * @param width - total row width in characters
 * @returns Rendered row string
 */
export function renderListRow(
	issueKey: string,
	icon: string,
	title: string,
	width: number,
): string {
	const availableTitle = calculateAvailableTitleWidth(width, issueKey.length);
	const truncated = truncateTitle(title, availableTitle);

	return `${icon} ${issueKey} ${truncated}`;
}

/**
 * Render a complete list view as ASCII art.
 * Shows which items are visible, which is selected, and how they fit.
 *
 * Selected rows are marked with `*` prefix (in the real UI, selection
 * is shown via inverse background — we use `*` as a visual indicator
 * in test output).
 *
 * @param items - Array of {issueKey, icon, title} for all items
 * @param selectedIndex - Currently selected item (0-based, in full list)
 * @param termHeight - Terminal height available for the list pane
 * @param width - Width of the list pane
 * @param hasStatusMessage - Whether a status message is shown
 * @returns Multi-line ASCII string of the visible list
 */
export function renderListView(
	items: Array<{issueKey: string; icon: string; title: string}>,
	selectedIndex: number,
	termHeight: number,
	width: number,
): string {
	const {scrollOffset, visibleCount, adjustedSelectedIndex} =
		calculateVisibleWindow(selectedIndex, items.length, termHeight);

	const visibleItems = items.slice(scrollOffset, scrollOffset + visibleCount);
	const rows: string[] = [];

	for (let i = 0; i < visibleItems.length; i++) {
		const item = visibleItems[i]!;
		const row = renderListRow(item.issueKey, item.icon, item.title, width);
		const prefix = i === adjustedSelectedIndex ? '*' : ' ';
		rows.push(`${prefix}${row}`);
	}

	return rows.join('\n');
}
