/**
 * Detection of a hand-dragged side pane.
 *
 * The rail (left) and companion (right) panes in 3-column mode normally get
 * widths derived from the terminal size by `calculateLayoutForSize`. Every
 * relayout re-applies those widths, which is why a hand-drag of a tmux pane
 * border used to snap back: a rail drag resizes the Ink pane and triggers a
 * relayout straight away, and a companion drag is undone by the next relayout
 * from any other cause (a dialog opening, a workspace being added).
 *
 * The fix is to tell a drag apart from a window resize. A *window* resize
 * changes the tmux window dimensions; a *pane drag* does not. So when the
 * window is the same size as it was at the previous relayout but a side pane
 * is not, the user moved that pane's border, and its new width becomes the
 * override for the rest of the process. The override lives in memory only, so
 * a fresh pappardelle always opens at the configured or derived width. That is
 * deliberate: see STA-2040.
 *
 * Kept pure so `pane-drag.test.ts` can cover the classification without a tmux
 * server. The clamping lives in `layout-sizing.ts` next to the widths it
 * constrains.
 */

/** Terminal or tmux window dimensions, as reported by tmux. */
export interface WindowSize {
	width: number;
	height: number;
}

/**
 * One side pane's observations for a relayout, gathered just before the panes
 * move.
 *
 * `previous*` values come from the end of the last relayout, and are measured
 * values rather than the widths we asked for, so tmux rounding never reads as a
 * drag. Any `null` means "unknown", which is treated as "not a drag".
 */
export interface PaneResizeSample {
	previousWindow: WindowSize | null;
	currentWindow: WindowSize | null;
	previousWidth: number | null;
	currentWidth: number | null;
	currentOverride: number | null;
}

/**
 * Decide the width override to use for this relayout.
 *
 * Returns the new override when the sample shows a hand-drag, and the existing
 * override otherwise. An established override survives window resizes so the
 * pane keeps the width the user chose.
 */
export function nextWidthOverride(sample: PaneResizeSample): number | null {
	const {
		previousWindow,
		currentWindow,
		previousWidth,
		currentWidth,
		currentOverride,
	} = sample;

	// Without both window samples we cannot rule out a window resize.
	if (!previousWindow || !currentWindow) return currentOverride;

	// The window changed size, so tmux re-proportioned the panes for us.
	if (
		previousWindow.width !== currentWindow.width ||
		previousWindow.height !== currentWindow.height
	) {
		return currentOverride;
	}

	if (previousWidth === null || currentWidth === null) {
		return currentOverride;
	}

	// Same window, different width: the user moved the border.
	if (previousWidth !== currentWidth) return currentWidth;

	return currentOverride;
}
