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

/** Rows consumed by header (1 line) + status message line (1 line) = 2 */
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

/**
 * Translate a mouse y coordinate into a visible-list row index, accounting
 * for the optional update banner that sits above the header. The banner's
 * content wraps at narrow pane widths so its footprint isn't a fixed
 * constant — the caller passes the current measured height (0 when the
 * banner is hidden). Returns null when the click is on chrome (banner /
 * header) or below the visible rows.
 */
export function calculateListClickRow(options: {
	y: number;
	bannerHeight: number;
	visibleRows: number;
}): number | null {
	const headerOffset = options.bannerHeight + HEADER_ROWS;
	const row = options.y - headerOffset;
	if (row < 0 || row >= options.visibleRows) return null;
	return row;
}

// ============================================================================
// Row rendering
// ============================================================================

/**
 * Extra content rendered at the right edge of the row: pipeline state icon
 * and parenthesized unresolved-comment count. Both slots are optional — when
 * both are empty the row renders as it did before the STA-862 rail-icons
 * change.
 */
export interface RailIcons {
	/** Single token for the pipeline icon (e.g. "✓", "◐◑"). Empty = hidden. */
	pipelineIcon?: string;
	/** Unresolved PR/MR comment count. 0 = hidden. */
	commentCount?: number;
}

/**
 * Optional emoji rendered to the left of the Claude status icon (the very
 * first cell on the row). `width` is the visual width in terminal cells —
 * most emoji render as 2 cells, but the caller is responsible for supplying
 * the correct width (e.g. via `string-width`).
 */
export interface RowPrefix {
	emoji?: string;
	width?: number;
}

/**
 * How many cells the left-side emoji prefix occupies, including the trailing
 * space that separates it from the Claude status icon. Returns 0 when no
 * emoji is set.
 */
export function rowPrefixWidth(prefix?: RowPrefix): number {
	if (!prefix?.emoji) return 0;
	const width = prefix.width ?? 2;
	return width + 1; // emoji + trailing space
}

/**
 * How many cells the right-aligned rail-icon cluster occupies. Includes one
 * leading space per chunk (separating the icons from the title and from
 * each other). Returns 0 when both pipeline and comment count are absent.
 *
 * The unresolved comment count is rendered as a parenthesized text token
 * `(N)` (no separate icon glyph) so it can be color-styled (gray) like
 * the rest of the rail.
 */
export function railPrefixWidth(icons?: RailIcons): number {
	if (!icons) return 0;
	let width = 0;
	if (icons.pipelineIcon && icons.pipelineIcon.length > 0) {
		// leading space + icon token
		width += 1 + icons.pipelineIcon.length;
	}

	if (icons.commentCount && icons.commentCount > 0) {
		// leading space + "(" + digits + ")"
		width += 1 + 1 + String(icons.commentCount).length + 1;
	}

	return width;
}

/**
 * Calculate available width for the title text in a list row.
 *
 * Row format:
 *   "[emoji space] icon space issueKey space title [space pipelineIcon] [space (count)]"
 *
 * Fixed overhead (without rail icons or emoji) = icon(1) + space(1) + space(1) = 3
 * Total fixed = 3 + issueKey.length + rowPrefixWidth(prefix) + railPrefixWidth(icons)
 *
 * @param totalWidth - Total width of the list pane in characters
 * @param issueKeyLength - Length of the issue key string (e.g. 7 for "STA-452")
 * @param icons - Optional rail icons (pipeline + unresolved comment count)
 * @param prefix - Optional left-side emoji prefix
 * @returns Number of characters available for the title
 */
export function calculateAvailableTitleWidth(
	totalWidth: number,
	issueKeyLength: number,
	icons?: RailIcons,
	prefix?: RowPrefix,
): number {
	return Math.max(
		0,
		totalWidth -
			ROW_FIXED_OVERHEAD -
			issueKeyLength -
			railPrefixWidth(icons) -
			rowPrefixWidth(prefix),
	);
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
 * Matches the SpaceListItem layout: icon first, then issue key, then title,
 * then right-aligned rail icons (unresolved-comment count, then pipeline
 * state flush at the far right).
 * Selection is shown via inverse background in the real UI, not in ASCII.
 *
 * Format: "· STA-452 Fix the bug (3) ✓"
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
	icons?: RailIcons,
	prefix?: RowPrefix,
): string {
	const availableTitle = calculateAvailableTitleWidth(
		width,
		issueKey.length,
		icons,
		prefix,
	);
	const truncated = truncateTitle(title, availableTitle);

	let suffix = '';
	if (icons?.commentCount && icons.commentCount > 0) {
		suffix += ` (${icons.commentCount})`;
	}

	if (icons?.pipelineIcon && icons.pipelineIcon.length > 0) {
		suffix += ` ${icons.pipelineIcon}`;
	}

	const emojiPrefix = prefix?.emoji ? `${prefix.emoji} ` : '';
	return `${emojiPrefix}${icon} ${issueKey} ${truncated}${suffix}`;
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
	items: Array<{
		issueKey: string;
		icon: string;
		title: string;
		pipelineIcon?: string;
		commentCount?: number;
	}>,
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
		const row = renderListRow(item.issueKey, item.icon, item.title, width, {
			pipelineIcon: item.pipelineIcon,
			commentCount: item.commentCount,
		});
		const prefix = i === adjustedSelectedIndex ? '*' : ' ';
		rows.push(`${prefix}${row}`);
	}

	return rows.join('\n');
}
