// Width-aware truncation for the ticket-rail title.
//
// The title is laid out by Ink, which sizes a <Text> box with its bundled
// `string-width` (via `widest-line`). A ✨ U+2728 is a single UTF-16 code unit
// but Ink lays it out as a 2-cell box, so the previous code-unit truncation
// (`title.slice(0, n)`) under-counted it: a kept ✨ pushed the title one cell
// past its width budget, shoving the right-aligned rail icons out of alignment
// (STA-1565 follow-up — the profile-emoji slot was fixed first; the title text
// has the same writer/layout mismatch).
//
// Measuring with `widest-line` (Ink's layout measure, the same library the
// profile-emoji fix adopted) and stepping by grapheme keeps the truncation in
// lockstep with how Ink sizes the row. `widest-line` is deliberately chosen over
// pappardelle's newer `string-width`, whose tables disagree with Ink's bundled
// copy for a few symbols (❤ ✂), so only `widest-line` predicts Ink's box.

import widestLine from 'widest-line';

// Grapheme stepping so a VS16 / ZWJ emoji (⚙️ = U+2699 U+FE0F, 👨‍👩‍👧) is measured
// and cut as one unit rather than split mid-cluster.
const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: 'grapheme',
});

/**
 * Truncate `text` to at most `maxCells` terminal columns *as Ink lays them out*,
 * appending a one-cell '…' when it doesn't fit. Returns '' for a non-positive
 * budget. Width is measured with `widest-line` so multi-cell emoji (✨ counts as
 * 2) reserve the columns Ink will actually size their box at — the previous
 * `String.slice` counted UTF-16 code units and overflowed on those emoji.
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
