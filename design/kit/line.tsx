import type {ColorInput} from '@opentui/core';
import stringWidth from 'string-width';
import {terminalColor, textAttributes} from '../../source/tui-style.ts';
import {truncateToWidth} from '../../source/truncate-to-width.ts';
import {clipIssueKey} from '../../source/list-view-sizing.ts';

export type Seg = {
	text: string;
	fg?: ColorInput;
	bg?: ColorInput;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
	/** Expands to fill the remaining width (one per line). */
	grow?: boolean;
	/** Shrinks with an ellipsis when the line overflows (one per line). */
	shrink?: boolean;
	/**
	 * May be left out on a narrow rail (see dropExtras). Lower numbers go
	 * first.
	 */
	drop?: number;
	/**
	 * Cut without an ellipsis as a last resort, the way the app clips an
	 * issue key (`clipIssueKey`): a key is an identifier, so every cell goes
	 * to its characters.
	 */
	clip?: boolean;
};

/**
 * The order every direction gives things up in on a narrow rail: ambient
 * decoration and how long a state has lasted, then the comment count. The
 * pipeline and PR glyphs carry failures, so they outrank the title's minimum.
 */
export const DROP = {decoration: 1, age: 1, comments: 2, pipeline: 3} as const;

/** Cells a title keeps before a row starts giving up its extras. */
export const MIN_SHRINK = 6;

export const width = (segs: Seg[]) =>
	segs.reduce((sum, seg) => sum + stringWidth(seg.text), 0);

/**
 * The shared narrow-rail rule. Extras below the pipeline tier go, lowest
 * first, until the `shrink` segment (the title) can keep MIN_SHRINK cells.
 * Pipeline-tier extras go only when the title couldn't even keep its `…`.
 * Nothing comes back once dropped, so widening a rail only ever adds to a
 * row.
 */
export function dropExtras(segs: Seg[], cols: number): Seg[] {
	const fits = (list: Seg[], minimum: number) => {
		const shrink = list.find(seg => seg.shrink);
		const keep = shrink ? Math.min(minimum, stringWidth(shrink.text)) : 0;
		return width(list.filter(seg => !seg.shrink)) + keep <= cols;
	};

	const minimumFor = (seg: Seg) =>
		(seg.drop ?? 0) < DROP.pipeline ? MIN_SHRINK : 1;
	const order = segs
		.filter(seg => seg.drop !== undefined)
		.sort((a, b) => (a.drop ?? 0) - (b.drop ?? 0));
	let kept = segs;
	for (const seg of order) {
		if (fits(kept, minimumFor(seg))) continue;
		kept = kept.filter(other => other !== seg);
	}

	return kept;
}

/**
 * One terminal row built from styled segments, sized to exactly `cols`
 * cells: `drop` extras go first (see dropExtras), then the `shrink` segment
 * truncates, then a `clip` segment is cut, then a `grow` segment pads.
 * Explicit sizing keeps every direction's rows on the same grid rules as the
 * app's rail (emoji widths, ellipsis, no wrapping).
 */
export function Line({
	segs,
	cols,
	bg,
}: {
	segs: Seg[];
	cols: number;
	bg?: ColorInput;
}) {
	const sized = dropExtras(segs, cols).map(seg => ({...seg}));
	let over = width(sized) - cols;
	const shrink = sized.find(seg => seg.shrink);
	if (over > 0 && shrink?.text) {
		const target = Math.max(1, stringWidth(shrink.text) - over);
		shrink.text = truncateToWidth(shrink.text, target);
		over = width(sized) - cols;
	}

	const clip = sized.find(seg => seg.clip);
	if (over > 0 && clip) {
		clip.text = clipIssueKey(clip.text, stringWidth(clip.text) - over);
		over = width(sized) - cols;
	}

	const grow = sized.find(seg => seg.grow);
	if (over < 0) {
		const pad = ' '.repeat(-over);
		if (grow) grow.text += pad;
		else sized.push({text: pad});
	}

	return (
		<text wrapMode="none" height={1} width={cols}>
			{sized.map((seg, index) => (
				<span
					key={index}
					fg={seg.fg ?? terminalColor()}
					bg={seg.bg ?? bg}
					attributes={textAttributes({
						bold: seg.bold,
						dim: seg.dim,
						italic: seg.italic,
						underline: seg.underline,
						inverse: seg.inverse,
					})}
				>
					{seg.text}
				</span>
			))}
		</text>
	);
}

/** A column of Lines, top-aligned, filling `rows` with blank lines. */
export function Block({
	lines,
	cols,
	rows,
	bg,
}: {
	lines: Seg[][];
	cols: number;
	rows?: number;
	bg?: ColorInput;
}) {
	const filled =
		rows === undefined
			? lines
			: [
					...lines.slice(0, rows),
					...Array.from({length: Math.max(0, rows - lines.length)}, () => []),
				];
	return (
		<box flexDirection="column" width={cols}>
			{filled.map((segs, index) => (
				<Line key={index} segs={segs} cols={cols} bg={bg} />
			))}
		</box>
	);
}
