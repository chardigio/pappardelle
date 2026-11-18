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

/** Fixed-width characters per row (excluding issue key): icon(1) + space(1) + space(1) = 3 */
export const ROW_FIXED_OVERHEAD = 3;

export type LinesPerItem = 1 | 2;

// ============================================================================
// Scrolling / visibility
// ============================================================================

/** Rows a rail box's frame takes: its top and bottom borders. */
export const BOX_FRAME_ROWS = 2;

/** The status row, or the search row while searching. */
export const STATUS_ROWS = 1;

/**
 * Whether the workspace box keeps its status row. In a pane too short for both
 * boxes, the agent rows and one space, the status row gives up its row so the
 * selected space stays on screen.
 */
export function statusLineFits(
	paneRows: number,
	bannerHeight: number,
	agentRows: number,
	linesPerItem: LinesPerItem = 1,
): boolean {
	return (
		paneRows - bannerHeight >=
		2 * BOX_FRAME_ROWS + STATUS_ROWS + agentRows + linesPerItem
	);
}

/**
 * Rows left for the rows that scroll. Split, the workspace box holds the
 * banner, status row and agent rows above the rail box. Merged (search and
 * the stacked rail), one box holds the banner, the status or search row and
 * every row.
 */
export function railListRows(
	layout:
		| {
				merged: false;
				paneRows: number;
				bannerHeight: number;
				statusRows: number;
				agentRows: number;
		  }
		| {merged: true; paneRows: number; bannerHeight: number},
): number {
	return layout.merged
		? layout.paneRows - BOX_FRAME_ROWS - layout.bannerHeight - STATUS_ROWS
		: layout.paneRows -
				2 * BOX_FRAME_ROWS -
				layout.bannerHeight -
				layout.statusRows -
				layout.agentRows;
}

/**
 * The window over the rows that scroll, and whether the status row keeps its
 * row. Merged (search and the stacked rail), the status or search row always
 * shows. Split, it gives way when the pane is too short for it (see
 * `statusLineFits`) or when keeping it would leave the rail box without a
 * space, such as a group header taking the only row.
 */
export function railWindow(layout: {
	merged: boolean;
	rows: ReadonlyArray<{height: number; isSpace: boolean}>;
	cursorRow: number;
	paneRows: number;
	bannerHeight: number;
	agentRows: number;
	linesPerItem: LinesPerItem;
}): {
	statusFits: boolean;
	listRows: number;
	scrollOffset: number;
	visibleCount: number;
} {
	const {rows, cursorRow, paneRows, bannerHeight, agentRows} = layout;
	const heights = rows.map(row => row.height);
	const windowFor = (statusFits: boolean, listRows: number) => ({
		statusFits,
		listRows,
		...calculateRowWindow(heights, cursorRow, listRows),
	});
	const splitWindow = (statusFits: boolean) =>
		windowFor(
			statusFits,
			railListRows({
				merged: false,
				paneRows,
				bannerHeight,
				statusRows: statusFits ? STATUS_ROWS : 0,
				agentRows,
			}),
		);

	if (layout.merged)
		return windowFor(
			true,
			railListRows({merged: true, paneRows, bannerHeight}),
		);
	if (!statusLineFits(paneRows, bannerHeight, agentRows, layout.linesPerItem))
		return splitWindow(false);
	const kept = splitWindow(true);
	const showsSpace = rows
		.slice(kept.scrollOffset, kept.scrollOffset + kept.visibleCount)
		.some(row => row.isSpace);
	return showsSpace || !rows.some(row => row.isSpace)
		? kept
		: splitWindow(false);
}

/**
 * The rail's count of the spaces it lists: `12 spaces`, or `4-9 of 12` while
 * only some are on screen. Nothing when there are none.
 */
export function spaceCountLabel(
	firstShown: number,
	shown: number,
	total: number,
): string | undefined {
	if (total === 0) return undefined;
	if (shown === 0 || shown === total)
		return `${total} space${total === 1 ? '' : 's'}`;
	if (shown === 1) return `${firstShown} of ${total}`;
	return `${firstShown}-${firstShown + shown - 1} of ${total}`;
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
 * The visible window over rows of different heights: the grouped rail mixes
 * one-line group headers with two-line spaces. Keeps the cursor row near the
 * middle, measured in terminal lines.
 */
export function calculateRowWindow(
	heights: readonly number[],
	cursorRow: number,
	listRows: number,
): {scrollOffset: number; visibleCount: number} {
	const count = heights.length;
	if (count === 0) return {scrollOffset: 0, visibleCount: 0};
	const cursor = Math.min(Math.max(cursorRow, 0), count - 1);
	const budget = Math.max(heights[cursor]!, listRows);
	const total = heights.reduce((sum, height) => sum + height, 0);
	if (total <= budget) return {scrollOffset: 0, visibleCount: count};

	const linesAbove = Math.min(
		Math.floor(budget / 2),
		budget - heights[cursor]!,
	);
	let start = cursor;
	let used = heights[cursor]!;
	while (
		start > 0 &&
		used - heights[cursor]! + heights[start - 1]! <= linesAbove
	) {
		start--;
		used += heights[start]!;
	}

	let end = cursor + 1;
	while (end < count && used + heights[end]! <= budget) {
		used += heights[end]!;
		end++;
	}

	while (start > 0 && used + heights[start - 1]! <= budget) {
		start--;
		used += heights[start]!;
	}

	return {scrollOffset: start, visibleCount: end - start};
}

// ============================================================================
// Row rendering
// ============================================================================

/**
 * Extra content rendered at the right edge of the row: pipeline state icon,
 * parenthesized unresolved-comment count, and merge-conflict indicator. All
 * slots are optional — when all are empty the row renders as it did before
 * the STA-862 rail-icons change.
 *
 * Right-side rendering order (left → right): commentCount, conflict, pipeline.
 */
export interface RailIcons {
	/** Single token for the pipeline icon (e.g. "✓", "◐◑"). Empty = hidden. */
	pipelineIcon?: string;
	/** Unresolved PR/MR comment count. 0 = hidden. */
	commentCount?: number;
	/** True when the PR can't be merged due to conflicts. Renders as ↯. */
	hasConflict?: boolean;
}

/**
 * Optional emoji rendered to the left of the Claude status icon (the very
 * first cell on the row). `width` is the visual width in terminal cells —
 * most emoji render as 2 cells, but the caller is responsible for supplying
 * the correct width (e.g. via `displayWidth` in `text-measure.ts`).
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
 * Columns the two-line layout indents its title row by, so the title starts
 * under the issue key rather than under the status icon.
 */
export function twoLineTitleIndent(prefix?: RowPrefix): number {
	return rowPrefixWidth(prefix) + ROW_ICON_CELLS;
}

export function titleSharesKeyLine(options: {
	isTwoLine: boolean;
	isPending?: boolean;
}): boolean {
	return !options.isTwoLine || options.isPending === true;
}

/**
 * How many cells the right-aligned rail-icon cluster occupies. Includes one
 * leading space per chunk (separating the icons from the title and from
 * each other). Returns 0 when pipeline, comment count, and conflict flag are
 * all absent.
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

	if (icons.hasConflict) {
		// leading space + ↯ (1 cell)
		width += 2;
	}

	return width;
}

/**
 * Cells the status icon and its trailing space always occupy, before the key.
 */
export const ROW_ICON_CELLS = 2;

/**
 * Clip an issue key to the columns a very narrow rail leaves for it.
 *
 * The key normally fits with room to spare, so this is a no-op at every ordinary
 * width. It matters once someone drags the rail down to the key alone (STA-2040):
 * without a clip the key overflows its row and can wrap onto a second line,
 * which breaks the intended one-row-per-space layout.
 *
 * No ellipsis. A key is an identifier, so at these widths every column is better
 * spent on characters of the key than on a marker.
 *
 * @param issueKey - e.g. "STA-2040"
 * @param availableWidth - columns left after the emoji prefix and status icon
 */
export function clipIssueKey(issueKey: string, availableWidth: number): string {
	if (availableWidth <= 0) return '';
	return issueKey.slice(0, availableWidth);
}

/**
 * Calculate available width for the title text in a list row.
 *
 * Row format:
 *   "[emoji space] icon space issueKey space title [space (count)] [space conflict] [space pipelineIcon]"
 *
 * Fixed overhead (without rail icons or emoji) = icon(1) + space(1) + space(1) = 3
 * Total fixed = 3 + issueKey.length + rowPrefixWidth(prefix) + railPrefixWidth(icons)
 *
 * @param totalWidth - Total width of the list pane in characters
 * @param issueKeyLength - Length of the issue key string (e.g. 7 for "STA-452")
 * @param icons - Optional rail icons (pipeline + unresolved comment count + conflict flag)
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
 * then right-aligned rail icons (unresolved-comment count, then merge-conflict
 * indicator, then pipeline state flush at the far right).
 * Selection is shown via inverse background in the real UI, not in ASCII.
 *
 * Format: "· STA-452 Fix the bug (3) ↯ ✓"
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

	if (icons?.hasConflict) {
		suffix += ' ↯'; // ↯
	}

	if (icons?.pipelineIcon && icons.pipelineIcon.length > 0) {
		suffix += ` ${icons.pipelineIcon}`;
	}

	const emojiPrefix = prefix?.emoji ? `${prefix.emoji} ` : '';
	return `${emojiPrefix}${icon} ${issueKey} ${truncated}${suffix}`;
}
