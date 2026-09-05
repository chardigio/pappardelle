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
