/**
 * Pure color/attribute resolution for a space-list row's highlight state.
 *
 * A row can be highlighted two ways, and they mean different things:
 *   - it needs attention (Claude is blocked on a permission or a question) —
 *     drawn as a blinking colored block, red for approvals, blue for questions
 *   - it is the selected row — drawn as a plain inverse block
 *
 * Both use the terminal's `inverse` attribute, which swaps foreground and
 * background. That swap is the whole reason this lives in its own module: under
 * `inverse` the color you set is the color the row is *painted* with, and the
 * text is drawn in the terminal's background color.
 */

export interface RowHighlightInput {
	isSelected: boolean;
	/** Claude is waiting on the user (permission request or question). */
	needsAttention: boolean;
	/** Current phase of the attention blink. */
	blinkOn: boolean;
	/** The attention is an AskUserQuestion rather than a permission request. */
	isQuestion: boolean;
	/** Tracker-supplied workflow-state color for the issue key. */
	stateColor: string;
}

export interface RowHighlight {
	useBlinkInverse: boolean;
	useSelectionInverse: boolean;
	useInverse: boolean;
	/** Color for the row's non-highlighted chrome (emoji, status icon, spaces). */
	textColor: string | undefined;
	/** Color for the issue key badge. */
	keyColor: string | undefined;
	/** Color for the issue title. */
	titleColor: string | undefined;
}

/**
 * State colors that mean "this issue has no color worth showing" rather than
 * naming a real one. They all resolve to ANSI 8, which Solarized — and every
 * palette derived from it — defines as the *background*, so a key painted with
 * one is invisible until selection inverts it.
 *
 * The key falls back to the terminal's default foreground rather than to a dim
 * of it: SGR 2 is a blend toward the background, which on a low-contrast theme
 * lands the row's primary identity around 2:1 against the pane, and Ink drops
 * the key's `bold` when both are set (they share reset code 22). Muted here
 * means "carries no state color", not "drawn faintly" — dimming is left to the
 * title and the rail, which are chrome and can afford to recede.
 */
const BACKGROUND_RISK_COLORS = new Set(['gray', 'grey', 'blackBright']);

export function resolveRowHighlight(input: RowHighlightInput): RowHighlight {
	const useBlinkInverse = input.needsAttention && input.blinkOn;
	const useSelectionInverse = input.isSelected && !useBlinkInverse;
	const useInverse = useBlinkInverse || useSelectionInverse;

	const textColor = useBlinkInverse
		? input.isQuestion
			? 'blue'
			: 'red'
		: undefined;

	// A tracker-supplied state color is the worst possible choice for a selected
	// row. Inverted, it becomes the highlight's background — and nothing
	// constrains what the tracker hands us, so a state color near the user's
	// terminal background paints an invisible highlight, while the gray fallback
	// the main worktree and untitled spaces fall back to paints a barely-there
	// one. Leaving the color unset inverts against the terminal's own default
	// foreground instead, the one pairing guaranteed to contrast on both light
	// and dark themes. The state color still owns the key on unselected rows,
	// where it is a foreground and carries its normal meaning.
	const keyColor =
		useSelectionInverse || BACKGROUND_RISK_COLORS.has(input.stateColor)
			? undefined
			: input.stateColor;
	const titleColor = useSelectionInverse ? undefined : textColor;

	return {
		useBlinkInverse,
		useSelectionInverse,
		useInverse,
		textColor,
		keyColor,
		titleColor,
	};
}
