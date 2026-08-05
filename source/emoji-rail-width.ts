// Width helpers for the ticket-rail profile emoji.
//
// The reason this file exists at all: Ink measures and draws an emoji with two
// *different* width functions, and for one class of emoji they disagree.
//
//   - Layout (Yoga) sizes a <Text> box at `widest-line` — i.e. Ink's bundled
//     `string-width` — which reports ✨ (U+2728) as 2 cells.
//   - The cell-writer (ink/build/output.js) advances by 2 columns for a
//     character only when `char.fullWidth || char.value.length > 1`.
//
// A single-BMP, default-emoji-presentation symbol — ✨ U+2728, ⭐ U+2B50,
// ✅ U+2705, ⚡ U+26A1 … — is one code unit (`value.length === 1`) and is not
// East-Asian-wide (`fullWidth === false`), so the writer draws it as **1** cell
// and pads the 2-cell layout box with a trailing space. Astral emoji
// (🍝 U+1F35D — a surrogate pair, length 2) and VS16-qualified emoji
// (⚙️ U+2699 U+FE0F — a second cell) clear the writer's checks; text-default
// symbols Ink lays out as 1 cell (❤ U+2764, ✂ U+2702) match the writer. None
// of those get padded.
//
// `SpaceListItem` uses `railEmojiIsInkPadded` to decide whether to emit its own
// separator: when Ink already pads, that pad cell *is* the separator, so a
// second explicit space would double it up (STA-1565).
//
// The pad is not just cosmetic, though: it is a real character the terminal
// draws *in addition to* the two columns it paints the glyph in, so the emitted
// row runs one column past the box it was laid out in. STA-1861 closes that gap
// at the source — `resolveEmojiSlot` runs the glyph through
// `normalizeRailEmoji`, which appends U+FE0F so the writer advances the full
// two cells and leaves nothing behind. Rail emoji therefore no longer expand
// past their layout; arbitrary text (issue titles) still can, which is why
// `inkRenderPad` remains in use for those.
//
// Both sides are measured the way Ink itself measures them — `widest-line` for
// the layout box and `@alcalzone/ansi-tokenize` for the writer — rather than
// pappardelle's own (newer) `string-width`, whose width tables differ from
// Ink's bundled copy for exactly these symbols. The render test in
// `components/space-list-item-emoji.test.ts` exercises real Ink and flags any
// future drift between the two libraries.

import {styledCharsFromTokens, tokenize} from '@alcalzone/ansi-tokenize';
import widestLine from 'widest-line';

/**
 * Cells Ink's renderer actually advances when drawing `text` — which is NOT
 * always its layout width. Computed with the same tokenizer and the same
 * `fullWidth || value.length > 1` rule as `output.js`.
 */
export function inkRenderWidth(text: string): number {
	return styledCharsFromTokens(tokenize(text)).reduce(
		(total, char) => total + (char.fullWidth || char.value.length > 1 ? 2 : 1),
		0,
	);
}

/**
 * Trailing spaces Ink appends when it draws `text`: the gap between the box it
 * reserved (`widest-line`) and the cells it actually advanced. Zero for normal
 * text; one per bare-BMP default-emoji symbol (✨ ⭐ ✅ …). This pad is real
 * output, so it widens the emitted row even though Ink's layout doesn't count
 * it — the caller has to reserve it explicitly or right-aligned content spills
 * past the row edge (STA-1565).
 */
export function inkRenderPad(text: string): number {
	return widestLine(text) - inkRenderWidth(text);
}

/**
 * True when Ink draws `emoji` narrower than its layout box reserved, so it pads
 * the box with a trailing space. The caller drops its explicit separator in
 * that case to avoid the doubled-space bug; the pad cell stands in as the
 * single separator instead.
 */
export function railEmojiIsInkPadded(emoji: string): boolean {
	return inkRenderPad(emoji) > 0;
}

/** U+FE0F — asks for emoji presentation; visually a no-op on emoji defaults. */
const VARIATION_SELECTOR_16 = '️';

/**
 * Widen an Ink-padded emoji so the writer advances the whole box it reserved.
 *
 * The pad is not free: it's a literal space Ink leaves behind in a cell the
 * terminal is *also* going to paint the glyph over, so the emitted row carries
 * one character more than its layout box is wide. Inside a bordered frame that
 * surplus column pushes the closing border past the pane edge, and the terminal
 * wraps it onto a line of its own — the phantom blank row under a ✨ profile in
 * the new-session picker (STA-1861).
 *
 * Appending U+FE0F takes the grapheme to `value.length === 2`, so the writer
 * consumes the cell instead of skipping it. VS16 is what the glyph already
 * renders as (these are emoji-presentation-by-default symbols), so nothing about
 * the drawn character changes — only how many cells Ink admits to using.
 *
 * The guard re-measures rather than trusting the rule, so a sequence a variation
 * selector can't rescue falls through untouched instead of gaining a stray code
 * point. Deliberately scoped to `railEmojiIsInkPadded`: text-presentation
 * defaults (❤ U+2764, ✂ U+2702) are *not* padded, and real terminals paint them
 * one cell wide exactly as Ink lays them out — widening those would change the
 * glyph the user configured to fix a bug they don't have.
 */
export function normalizeRailEmoji(emoji: string): string {
	if (!railEmojiIsInkPadded(emoji)) return emoji;
	const widened = emoji + VARIATION_SELECTOR_16;
	return inkRenderWidth(widened) >= widestLine(emoji) ? widened : emoji;
}

/**
 * The rail's three-state emoji slot, shared so the ticket rail and the
 * new-session profile picker can't drift apart:
 *
 *   - `undefined` — no profile anywhere configures an emoji. There is no slot;
 *     rows render exactly as they did before emoji existed.
 *   - `''` — the slot exists but this row has nothing to put in it. Two spaces
 *     hold the column so emoji-bearing siblings still line up.
 *   - a glyph — render it, and emit a separator unless Ink's own pad already
 *     is one (see `railEmojiIsInkPadded`).
 *
 * `text` is the *normalized* glyph, so the slot is the single place a rail
 * emoji is made safe to draw — nothing downstream has to know about U+FE0F.
 *
 * `overflowCells` is how far the drawn row runs past the box Ink laid out for
 * it: the columns the terminal paints (`widest-line` on the configured glyph —
 * the measure that matched a real tmux pane during STA-1861's TUI QA) minus the
 * columns Ink's writer emits for what we hand it. Normalization drives this to
 * zero for the whole padded class, but callers that right-align content still
 * subtract it, so an emoji no variation selector can rescue can't silently push
 * their rail off the pane edge (STA-1565).
 */
export function resolveEmojiSlot(
	rawEmoji: string | undefined,
): {text: string; needsSeparator: boolean; overflowCells: number} | null {
	if (rawEmoji === undefined) return null;
	const raw = rawEmoji === '' ? '  ' : rawEmoji;
	const text = normalizeRailEmoji(raw);
	return {
		text,
		needsSeparator: !railEmojiIsInkPadded(text),
		overflowCells: Math.max(0, widestLine(raw) - inkRenderWidth(text)),
	};
}
