/**
 * Color/attribute resolution for a space-list row's highlight state.
 *
 * A row can be highlighted two ways, and they mean different things:
 *   - it needs attention (Claude is blocked on a permission or a question) —
 *     drawn as a blinking colored block, red for approvals, blue for questions
 *   - it is the selected row — drawn as a plain inverse bar
 *
 * The attention block is painted with an explicit background rather than the
 * terminal's `inverse` attribute. OpenTUI resolves `inverse` with an explicit
 * foreground by filling the background with that same color and then still
 * emitting SGR 7, so the terminal swaps two identical colors and the text
 * disappears into the block. Painting the block color as the background and
 * leaving the text in a default color draws the colored bar with readable
 * text on every theme.
 *
 * Selection keeps `inverse`, because only `inverse` can paint a bar in the
 * terminal's own foreground color. Every span on the row, icons included,
 * drops its color while selected: under `inverse` a span's color becomes the
 * bar, so the bar would break into tracker and status colors.
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
}

/** How a span looks on an unhighlighted row. */
export interface SpanStyle {
	fg?: string;
	bold?: boolean;
	dim?: boolean;
}

export interface SpanPaint {
	fg: ColorInput;
	bg: ColorInput | undefined;
	attributes: number;
}

export interface RowHighlight {
	paint: (span: SpanStyle) => SpanPaint;
}

// Solarized and its descendants map ANSI 8 to the background itself, so text
// painted bright black disappears. The default foreground contrasts with the
// background by construction.
const BACKGROUND_RISK_COLORS = new Set(['gray', 'grey', 'blackBright']);

export function resolveRowHighlight(input: RowHighlightInput): RowHighlight {
	const blinkColor =
		input.needsAttention && input.blinkOn
			? input.isQuestion
				? 'blue'
				: 'red'
			: undefined;
	const isSelectionShown = input.isSelected && blinkColor === undefined;

	const paint = (span: SpanStyle): SpanPaint => {
		if (blinkColor) {
			return {
				fg: RGBA.defaultBackground(),
				bg: terminalColor(blinkColor),
				attributes: textAttributes({bold: span.bold}),
			};
		}

		if (isSelectionShown) {
			return {
				fg: terminalColor(),
				bg: undefined,
				attributes: textAttributes({bold: span.bold, inverse: true}),
			};
		}

		return {
			fg: terminalColor(
				span.fg && BACKGROUND_RISK_COLORS.has(span.fg) ? undefined : span.fg,
			),
			bg: undefined,
			attributes: textAttributes({bold: span.bold, dim: span.dim}),
		};
	};

	return {paint};
}
