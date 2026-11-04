/**
 * Color/attribute resolution for a space-list row's highlight state.
 *
 * A row can be highlighted two ways, and they mean different things:
 *   - it needs attention (Claude is blocked on a permission or a question) —
 *     drawn as a blinking colored block, red for approvals, blue for questions
 *   - it is the selected row — drawn as a plain inverse block
 *
 * The attention block is painted with an explicit background rather than the
 * terminal's `inverse` attribute. OpenTUI resolves `inverse` with an explicit
 * foreground by filling the background with that same color and then still
 * emitting SGR 7, so the terminal swaps two identical colors and the text
 * disappears into the block. Painting the block color as the background and
 * leaving the text in a default color draws the colored bar with readable
 * text on every theme.
 *
 * Selection keeps `inverse`, but only with default colors: under `inverse` the
 * foreground becomes the highlight's background, so a tracker state color
 * there would let a color pappardelle doesn't control decide the contrast.
 */
import {RGBA, type ColorInput} from '@opentui/core';
import {terminalColor, textAttributes} from '../tui-style.ts';

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

/** How a span looks on an unhighlighted row. */
export interface SpanStyle {
	fg?: string;
	bold?: boolean;
	dim?: boolean;
	/** The span belongs to the selection block (the issue key and title). */
	selectable?: boolean;
}

export interface SpanPaint {
	fg: ColorInput;
	bg: ColorInput | undefined;
	attributes: number;
}

export interface RowHighlight {
	/** Color for the issue key badge on an unhighlighted row. */
	keyColor: string | undefined;
	paint: (span: SpanStyle) => SpanPaint;
}

const BACKGROUND_RISK_COLORS = new Set(['gray', 'grey', 'blackBright']);

export function resolveRowHighlight(input: RowHighlightInput): RowHighlight {
	const blinkColor =
		input.needsAttention && input.blinkOn
			? input.isQuestion
				? 'blue'
				: 'red'
			: undefined;
	const isSelectionShown = input.isSelected && blinkColor === undefined;

	const keyColor = BACKGROUND_RISK_COLORS.has(input.stateColor)
		? undefined
		: input.stateColor;

	const paint = (span: SpanStyle): SpanPaint => {
		if (blinkColor) {
			return {
				fg: RGBA.defaultBackground(),
				bg: terminalColor(blinkColor),
				attributes: textAttributes({bold: span.bold}),
			};
		}

		if (isSelectionShown && span.selectable) {
			return {
				fg: terminalColor(),
				bg: undefined,
				attributes: textAttributes({bold: span.bold, inverse: true}),
			};
		}

		return {
			fg: terminalColor(span.fg),
			bg: undefined,
			attributes: textAttributes({bold: span.bold, dim: span.dim}),
		};
	};

	return {keyColor, paint};
}
