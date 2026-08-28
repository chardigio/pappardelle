/**
 * Detection of a hand-dragged ticket rail.
 *
 * The rail (the left-hand list pane in 3-column mode) normally gets a width
 * derived from the terminal size by `calculateLayoutForSize`. That derivation
 * is re-applied on every SIGWINCH, which is why a hand-drag of the tmux pane
 * border used to snap back instantly: moving the border resizes the Ink pane,
 * which raises `resize` on stdout, which triggers a relayout that recomputes
 * the same width.
 *
 * The fix is to tell the two apart. A *window* resize changes the tmux window
 * dimensions; a *pane drag* does not. So when the window is the same size as it
 * was at the previous relayout but the rail pane is not, the user moved the
 * border, and that new width becomes the override for the rest of the process.
 * The override lives in memory only, so a fresh pappardelle always opens at the
 * derived default. That is deliberate: see STA-2040.
 *
 * Kept pure so `rail-width.test.ts` can cover the classification without a tmux
 * server. The clamping lives in `layout-sizing.ts` next to the widths it
 * constrains.
 */

/** Terminal or tmux window dimensions, as reported by tmux. */
export interface WindowSize {
	width: number;
	height: number;
}

/**
 * One relayout's worth of observations, gathered just before the panes move.
 *
 * `previous*` values come from the end of the last relayout, and are measured
 * values rather than the widths we asked for, so tmux rounding never reads as a
 * drag. Any `null` means "unknown", which is treated as "not a drag".
 */
export interface RailResizeSample {
	previousWindow: WindowSize | null;
	currentWindow: WindowSize | null;
	previousRailWidth: number | null;
	currentRailWidth: number | null;
	currentOverride: number | null;
}

/**
 * Decide the rail override to use for this relayout.
 *
 * Returns the new override when the sample shows a hand-drag, and the existing
 * override otherwise. An established override survives window resizes so the
 * rail keeps the width the user chose.
 */
export function nextRailWidthOverride(sample: RailResizeSample): number | null {
	const {
		previousWindow,
		currentWindow,
		previousRailWidth,
		currentRailWidth,
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

	if (previousRailWidth === null || currentRailWidth === null) {
		return currentOverride;
	}

	// Same window, different rail: the user moved the border.
	if (previousRailWidth !== currentRailWidth) return currentRailWidth;

	return currentOverride;
}
