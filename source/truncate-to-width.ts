// Width-aware truncation for the ticket-rail title.
//
// A ✨ U+2728 is a single UTF-16 code unit but takes 2 terminal cells, so the
// previous code-unit truncation (`title.slice(0, n)`) under-counted it: a kept ✨
// pushed the title one cell past its width budget, shoving the right-aligned
// rail icons out of alignment (STA-1565 follow-up).
//
// Widths come from OpenTUI with the renderer's width method: tmux forces the
// unicode method, while outside tmux a terminal without mode 2027 gets wcwidth,
// which counts each emoji code point. No JS width table matches both.

import type {WidthMethod} from '@opentui/core';
import {displayWidth} from './text-measure.ts';

// Grapheme stepping so a VS16 / ZWJ emoji (⚙️ = U+2699 U+FE0F, 👨‍👩‍👧) is measured
// and cut as one unit rather than split mid-cluster.
const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: 'grapheme',
});

/**
 * Truncate `text` to at most `maxCells` terminal columns as OpenTUI lays it
 * out, appending a one-cell '…' when it doesn't fit. Returns '' for a
 * non-positive budget.
 */
export function truncateToWidth(
	text: string,
	maxCells: number,
	widthMethod: WidthMethod,
): string {
	if (maxCells <= 0) return '';
	if (displayWidth(text, widthMethod) <= maxCells) return text;
	return cutToWidth(text, maxCells - 1, widthMethod) + '…';
}

function cutToWidth(
	text: string,
	maxCells: number,
	widthMethod: WidthMethod,
): string {
	let result = '';
	let width = 0;
	for (const {segment} of graphemeSegmenter.segment(text)) {
		const segmentWidth = displayWidth(segment, widthMethod);
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
	widthMethod: WidthMethod,
): Run[] {
	if (maxCells <= 0) return [];
	const widths = runs.map(run => displayWidth(run.text, widthMethod));
	const total = widths.reduce((sum, width) => sum + width, 0);
	if (total <= maxCells) return runs;

	const kept: Run[] = [];
	let remaining = maxCells;
	for (const [index, run] of runs.entries()) {
		const width = widths[index]!;
		if (width >= remaining) {
			kept.push({
				...run,
				text: cutToWidth(run.text, remaining - 1, widthMethod) + '…',
			});
			break;
		}

		kept.push(run);
		remaining -= width;
	}

	return kept;
}
