// Width-aware truncation for the ticket-rail title.
//
// A ✨ U+2728 is a single UTF-16 code unit but takes 2 terminal cells, so the
// previous code-unit truncation (`title.slice(0, n)`) under-counted it: a kept ✨
// pushed the title one cell past its width budget, shoving the right-aligned
// rail icons out of alignment (STA-1565 follow-up).
//
// OpenTUI measures text natively. Under tmux the renderer is forced to its
// `unicode` width method, which agrees with `widest-line` on emoji, CJK and
// symbols, so measuring with `widest-line` and stepping by grapheme keeps the
// cut within the cells OpenTUI lays out. The two still differ on Indic spacing
// marks (OpenTUI counts "किताब" as 3, `widest-line` as 5) and the soft hyphen.

import widestLine from 'widest-line';

// Grapheme stepping so a VS16 / ZWJ emoji (⚙️ = U+2699 U+FE0F, 👨‍👩‍👧) is measured
// and cut as one unit rather than split mid-cluster.
const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: 'grapheme',
});

/**
 * Truncate `text` to at most `maxCells` terminal columns, appending a one-cell
 * '…' when it doesn't fit. Returns '' for a non-positive budget. Width is
 * measured with `widest-line`, so multi-cell emoji (✨ counts as 2) reserve the
 * columns OpenTUI lays them out at.
 */
export function truncateToWidth(text: string, maxCells: number): string {
	if (maxCells <= 0) return '';
	if (widestLine(text) <= maxCells) return text;
	return cutToWidth(text, maxCells - 1) + '…';
}

function cutToWidth(text: string, maxCells: number): string {
	let result = '';
	let width = 0;
	for (const {segment} of graphemeSegmenter.segment(text)) {
		const segmentWidth = widestLine(segment);
		if (width + segmentWidth > maxCells) break;
		result += segment;
		width += segmentWidth;
	}

	return result;
}

/**
 * `truncateToWidth` across differently styled runs of one line: runs that fit
 * are kept whole, and the run that crosses the budget is cut and carries the
 * ellipsis in its own style.
 */
export function truncateRunsToWidth<Run extends {text: string}>(
	runs: Run[],
	maxCells: number,
): Run[] {
	if (maxCells <= 0) return [];
	const total = runs.reduce((sum, run) => sum + widestLine(run.text), 0);
	if (total <= maxCells) return runs;

	const kept: Run[] = [];
	let remaining = maxCells;
	for (const run of runs) {
		const width = widestLine(run.text);
		if (width >= remaining) {
			kept.push({...run, text: cutToWidth(run.text, remaining - 1) + '…'});
			break;
		}

		kept.push(run);
		remaining -= width;
	}

	return kept;
}
