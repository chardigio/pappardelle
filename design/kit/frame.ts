/* eslint-disable no-bitwise -- OpenTUI text attributes are bit flags. */
import type {ReactNode} from 'react';
import {TextAttributes, type CapturedFrame, type RGBA} from '@opentui/core';
import {createRoot, flushSync} from '@opentui/react';
import {createTestRenderer} from '@opentui/core/testing';

/**
 * A terminal color as the artifact needs it: `'d'` is the terminal's own
 * default fg/bg, a number is an ANSI palette slot, a string is exact RGB.
 * Keeping palette slots symbolic is what lets the page re-theme the 16-color
 * tier for light and dark terminals.
 */
export type Color = 'd' | number | string;

/** [text, fg, bg, attributes (OpenTUI TextAttributes bits), cells] */
export type Span = [string, Color, Color, number, number];

export type Frame = {cols: number; rows: number; lines: Span[][]};

export type Cell = {char: string; fg: Color; bg: Color; attrs: number};

/** Attributes that draw something even on a space. */
const SHOWS_ON_SPACE =
	TextAttributes.UNDERLINE |
	TextAttributes.INVERSE |
	TextAttributes.STRIKETHROUGH;

/** Whether a space in this style draws nothing at all. */
const isInvisibleSpace = (bg: Color, attrs: number) =>
	bg === 'd' && (attrs & SHOWS_ON_SPACE) === 0;

/** True for a row a terminal would show as empty. */
export const isBlankLine = (line: Span[]) =>
	line.every(
		([text, , bg, attrs]) => text.trim() === '' && isInvisibleSpace(bg, attrs),
	);

const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');

export function colorOf(rgba: RGBA, isBackground: boolean): Color {
	if (rgba.intent === 'default') return 'd';
	if (rgba.intent === 'indexed') return rgba.slot;
	if (isBackground && rgba.a === 0) return 'd';
	return `#${hex(rgba.r * 255)}${hex(rgba.g * 255)}${hex(rgba.b * 255)}`;
}

export function fromCaptured(captured: CapturedFrame): Frame {
	return {
		cols: captured.cols,
		rows: captured.rows,
		lines: captured.lines.map(line =>
			mergeSpans(
				line.spans.map(span => [
					span.text,
					colorOf(span.fg, false),
					colorOf(span.bg, true),
					span.attributes,
					span.width,
				]),
			),
		),
	};
}

function sameStyle(a: Span, b: Span) {
	return a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

const segmenter = new Intl.Segmenter();

/**
 * Merges same-style runs, but keeps every wide grapheme (emoji, CJK) in a
 * span of its own, so a renderer can size each grapheme as width ÷ length.
 */
function mergeSpans(spans: Span[]): Span[] {
	const merged: Span[] = [];
	let lastWasWide = false;
	for (const span of spans) {
		for (const {segment} of segmenter.segment(span[0])) {
			const width = Bun.stringWidth(segment);
			if (width === 0 && segment !== '') continue;
			const isWide = width > 1;
			const last = merged.at(-1);
			if (last && !isWide && !lastWasWide && sameStyle(last, span)) {
				last[0] += segment;
				last[4] += width;
			} else {
				merged.push([segment, span[1], span[2], span[3], width]);
			}

			lastWasWide = isWide;
		}
	}

	return merged;
}

export type OffscreenSession = {
	render(node: ReactNode): Promise<Frame>;
	dispose(): Promise<void>;
};

/** One offscreen OpenTUI renderer reused across frames of a sequence. */
export async function openOffscreen(
	cols: number,
	rows: number,
): Promise<OffscreenSession> {
	const setup = await createTestRenderer({width: cols, height: rows});
	const root = createRoot(setup.renderer);
	return {
		async render(node) {
			flushSync(() => {
				root.render(node);
			});
			await setup.renderOnce();
			return fromCaptured(setup.captureSpans());
		},
		async dispose() {
			root.unmount();
			await setup.dispose();
		},
	};
}

export async function renderFrame(
	node: ReactNode,
	cols: number,
	rows: number,
): Promise<Frame> {
	const session = await openOffscreen(cols, rows);
	try {
		return await session.render(node);
	} finally {
		await session.dispose();
	}
}

type Pen = {fg: Color; bg: Color; attrs: number};

const SET_ATTRIBUTE: Record<number, number> = {
	1: TextAttributes.BOLD,
	2: TextAttributes.DIM,
	3: TextAttributes.ITALIC,
	4: TextAttributes.UNDERLINE,
	5: TextAttributes.BLINK,
	7: TextAttributes.INVERSE,
	8: TextAttributes.HIDDEN,
	9: TextAttributes.STRIKETHROUGH,
};
const CLEAR_ATTRIBUTE: Record<number, number> = {
	22: TextAttributes.BOLD | TextAttributes.DIM,
	23: TextAttributes.ITALIC,
	24: TextAttributes.UNDERLINE,
	25: TextAttributes.BLINK,
	27: TextAttributes.INVERSE,
	28: TextAttributes.HIDDEN,
	29: TextAttributes.STRIKETHROUGH,
};

const rgb = ([r, g, b]: number[]) => `#${hex(r!)}${hex(g!)}${hex(b!)}`;

/**
 * Reads an extended color (38 fg, 48 bg, 58 underline) at `params[i]` and
 * returns it with the number of following parameters it used. The `;` form
 * spreads it over parameters (`38;5;n`, `38;2;r;g;b`); the `:` form keeps it
 * in one (`38:5:n`, `38:2:r:g:b`, or ITU T.416's `38:2:cs:r:g:b`, whose
 * color-space id tmux leaves empty).
 */
function extendedColor(params: number[][], i: number): [Color, number] {
	const [, ...sub] = params[i]!;
	if (sub.length === 0) {
		const [mode, ...rest] = params.slice(i + 1).map(([p]) => p!);
		return mode === 5 ? [rest[0]!, 2] : [rgb(rest), 4];
	}

	if (sub[0] === 5) return [sub[1]!, 0];
	return [rgb(sub.length >= 5 ? sub.slice(2) : sub.slice(1)), 0];
}

function applySgr(pen: Pen, raw: string): Pen {
	const params = raw
		.split(';')
		.map(param =>
			param.split(':').map(part => (part === '' ? 0 : Number(part))),
		);
	let {fg, bg, attrs} = pen;
	for (let i = 0; i < params.length; i++) {
		const [p = 0, style] = params[i]!;
		if (SET_ATTRIBUTE[p]) attrs |= SET_ATTRIBUTE[p];
		if (CLEAR_ATTRIBUTE[p]) attrs &= ~CLEAR_ATTRIBUTE[p];
		if (p >= 30 && p <= 37) fg = p - 30;
		if (p >= 90 && p <= 97) fg = p - 90 + 8;
		if (p >= 40 && p <= 47) bg = p - 40;
		if (p >= 100 && p <= 107) bg = p - 100 + 8;
		switch (p) {
			case 0: {
				fg = 'd';
				bg = 'd';
				attrs = 0;
				break;
			}

			// `4:n` picks an underline style (curly, dotted, ...); `4:0` is none.
			case 4: {
				if (style === 0) attrs &= ~TextAttributes.UNDERLINE;
				break;
			}

			case 39: {
				fg = 'd';
				break;
			}

			case 49: {
				bg = 'd';
				break;
			}

			case 38:
			case 48:
			case 58: {
				const [color, used] = extendedColor(params, i);
				i += used;
				// The underline color (58) isn't part of a frame.
				if (p === 38) fg = color;
				if (p === 48) bg = color;
				break;
			}

			default:
		}
	}

	return {fg, bg, attrs};
}

const graphemes = new Intl.Segmenter();
// tmux writes styles as SGR escape sequences, which start with ESC.
// eslint-disable-next-line no-control-regex
const SGR_SPLIT = /(\u001B\[[\d;:]*m)/;
// eslint-disable-next-line no-control-regex
const SGR = /^\u001B\[([\d;:]*)m$/;
/** OSC sequences (hyperlinks, titles) end with BEL or ST (ESC \). */
// eslint-disable-next-line no-control-regex
const OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const TAB_STOP = 8;

/**
 * Parses `tmux capture-pane -e -p` output into the same frame shape.
 * tmux writes SGR sequences, OSC 8 hyperlinks and text, one line per pane
 * row, so cell widths come straight from the graphemes. It only emits SGR
 * when the style changes, so the pen carries over from the end of the
 * previous line.
 */
export function fromAnsi(ansi: string, cols: number, rows: number): Frame {
	const lines: Span[][] = [];
	let pen: Pen = {fg: 'd', bg: 'd', attrs: 0};
	for (const text of ansi.replaceAll(OSC, '').split('\n').slice(0, rows)) {
		const spans: Span[] = [];
		let used = 0;
		// Past the crop edge the row's text is dropped, but its SGRs still set
		// the pen the next row starts with.
		let isCropped = false;
		for (const part of text.split(SGR_SPLIT)) {
			const sgr = SGR.exec(part);
			if (sgr) {
				pen = applySgr(pen, sgr[1]!);
				continue;
			}

			for (const {segment} of graphemes.segment(part)) {
				if (isCropped) break;
				const width =
					segment === '\t'
						? Math.min(cols, (Math.floor(used / TAB_STOP) + 1) * TAB_STOP) -
							used
						: Bun.stringWidth(segment);
				if (width <= 0) continue;
				if (used + width > cols) {
					isCropped = true;
					break;
				}

				spans.push([
					segment === '\t' ? ' '.repeat(width) : segment,
					pen.fg,
					pen.bg,
					pen.attrs,
					width,
				]);
				used += width;
			}
		}

		lines.push(mergeSpans(spans));
	}

	return {cols, rows, lines};
}

export function cells(frame: Frame): Cell[][] {
	return frame.lines.map(line => {
		const row: Cell[] = [];
		for (const [text, fg, bg, attrs, width] of line) {
			const graphemes = [...segmenter.segment(text)].map(s => s.segment);
			const widthPerGrapheme = width / graphemes.length;
			for (const char of graphemes) {
				row.push({char, fg, bg, attrs});
				for (let pad = 1; pad < widthPerGrapheme; pad++)
					row.push({char: '', fg, bg, attrs});
			}
		}

		return row;
	});
}

const isBlank = (cell: Cell | undefined) =>
	!cell || (cell.char === ' ' && isInvisibleSpace(cell.bg, cell.attrs));

export type CellDiff = {x: number; y: number; a?: Cell; b?: Cell};

/** Cell-by-cell differences, ignoring cells that draw nothing on either side. */
export function diffFrames(a: Frame, b: Frame): CellDiff[] {
	const left = cells(a);
	const right = cells(b);
	const diffs: CellDiff[] = [];
	for (let y = 0; y < Math.max(left.length, right.length); y++) {
		const rowA = left[y] ?? [];
		const rowB = right[y] ?? [];
		for (let x = 0; x < Math.max(rowA.length, rowB.length); x++) {
			const ca = rowA[x];
			const cb = rowB[x];
			if (isBlank(ca) && isBlank(cb)) continue;
			if (
				ca?.char !== cb?.char ||
				ca?.fg !== cb?.fg ||
				ca?.bg !== cb?.bg ||
				ca?.attrs !== cb?.attrs
			)
				diffs.push({x, y, a: ca, b: cb});
		}
	}

	return diffs;
}
