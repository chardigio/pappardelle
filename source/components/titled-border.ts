/**
 * Ink 4's `<Box borderStyle>` has no notion of a border title, so a dialog that
 * wants its heading *inside* the top edge has to draw that edge itself: this
 * module builds the top line, and the caller renders the remaining three edges
 * with a normal bordered `<Box borderTop={false}>`.
 *
 * The result is split into three pieces rather than one string so the caller can
 * style the title differently from the rule around it (bold white heading on a
 * green frame) — Ink can only vary style across separate `<Text>` nodes.
 */

type BorderStyleName = 'double' | 'round';

const BORDER_CHARS: Record<
	BorderStyleName,
	{topLeft: string; topRight: string; horizontal: string}
> = {
	double: {topLeft: '╔', topRight: '╗', horizontal: '═'},
	round: {topLeft: '╭', topRight: '╮', horizontal: '─'},
};

export type TitledBorderTop = {
	/** Top-left corner glyph — styled as border. */
	prefix: string;
	/** ` Title ` — styled as heading. Empty when there is no room (or no title). */
	label: string;
	/** Horizontal fill plus the top-right corner — styled as border. */
	suffix: string;
};

/**
 * Lay out `<corner><space><title><space><rule…><corner>` so the assembled line
 * is exactly `width` cells wide.
 *
 * Titles that would not fit are ellipsized rather than allowed to push the
 * corner past the box edge, which would desynchronize this hand-drawn top edge
 * from the Ink-drawn sides below it.
 */
export function buildTitledBorderTop(
	title: string,
	width: number,
	style: BorderStyleName,
): TitledBorderTop {
	const {topLeft, topRight, horizontal} = BORDER_CHARS[style];

	// Two corners always win over the title; below that there is nothing to draw.
	const inner = Math.max(0, width - 2);

	// A label needs at least ` x ` (3 cells) to read as a title at all.
	if (title.length === 0 || inner < 3) {
		return {
			prefix: topLeft,
			label: '',
			suffix: horizontal.repeat(inner) + topRight,
		};
	}

	// Reserve a trailing cell of rule so a full-width title still reads as a
	// frame rather than a solid line of text.
	const maxTitle = inner - 3;
	const shown =
		title.length <= maxTitle
			? title
			: title.slice(0, Math.max(0, maxTitle - 1)) + '…';

	const label = ` ${shown} `;
	const fill = Math.max(0, inner - label.length);

	return {
		prefix: topLeft,
		label,
		suffix: horizontal.repeat(fill) + topRight,
	};
}
