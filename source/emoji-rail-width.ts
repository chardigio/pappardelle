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
