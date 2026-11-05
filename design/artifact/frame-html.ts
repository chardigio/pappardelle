/* eslint-disable no-bitwise -- OpenTUI text attributes are bit flags. */
import type {Color, Span} from '../kit/frame.ts';
import {type Palette, xtermIndexColor} from './palettes.ts';

const BOLD = 1;
const DIM = 2;
const ITALIC = 4;
const UNDERLINE = 8;
const INVERSE = 32;
const HIDDEN = 64;
const STRIKETHROUGH = 128;

function resolve(color: Color, palette: Palette, isBackground: boolean) {
	if (color === 'd')
		return isBackground ? palette.background : palette.foreground;
	if (typeof color === 'number')
		return color < 16 ? palette.ansi[color]! : xtermIndexColor(color);
	return color;
}

function mix(a: string, b: string, amount: number) {
	const channel = (hex: string, i: number) =>
		Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
	const out = [0, 1, 2].map(i =>
		Math.round(channel(a, i) * (1 - amount) + channel(b, i) * amount)
			.toString(16)
			.padStart(2, '0'),
	);
	return `#${out.join('')}`;
}

const escapeHtml = (text: string) =>
	text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');

/**
 * JetBrains Mono's bold cut on Google Fonts has no rounded corners (╭ ╮ ╰ ╯),
 * so bold ones come from a fallback font wider than the cell. Box drawing
 * always renders at the regular weight to keep borders in one font.
 */
const isBoxDrawing = (grapheme: string) => grapheme >= '─' && grapheme <= '╿';

const segmenter = new Intl.Segmenter();

/**
 * Draws one row as a cell grid. Every grapheme gets its own box sized in
 * cells, so emoji and box-drawing glyphs cannot drift the columns the way
 * free-flowing monospace text does.
 */
export function rowToHtml(line: Span[], palette: Palette): string {
	const spans = line.map(([text, fg, bg, attrs, width]) => {
		let fore = resolve(fg, palette, false);
		let back = resolve(bg, palette, true);
		if (attrs & INVERSE) [fore, back] = [back, fore];
		if (attrs & DIM) fore = mix(fore, back, 0.45);
		if (attrs & HIDDEN) fore = back;
		const bold = Boolean(attrs & BOLD);
		const decoration = [
			attrs & UNDERLINE ? 'underline' : '',
			attrs & STRIKETHROUGH ? 'line-through' : '',
		]
			.filter(Boolean)
			.join(' ');
		const style = [
			`color:${fore}`,
			back === palette.background ? '' : `background:${back}`,
			bold ? 'font-weight:700' : '',
			attrs & ITALIC ? 'font-style:italic' : '',
			decoration ? `text-decoration:${decoration}` : '',
		]
			.filter(Boolean)
			.join(';');
		const graphemes = [...segmenter.segment(text)].map(s => s.segment);
		const cellsEach = width / Math.max(graphemes.length, 1);
		const inner = graphemes
			.map(g => {
				if (cellsEach > 1)
					return `<i class="w" style="width:${cellsEach}ch"><s>${escapeHtml(g)}</s></i>`;
				const weight = bold && isBoxDrawing(g) ? ';font-weight:400' : '';
				return `<i style="width:${cellsEach}ch${weight}">${g === ' ' ? '&nbsp;' : escapeHtml(g)}</i>`;
			})
			.join('');
		return `<b style="${style}">${inner}</b>`;
	});
	return `<div class="row">${spans.join('')}</div>`;
}

/**
 * Wraps rendered rows in a frame. Screen readers get the frame as one image
 * named by `label`, not as thousands of single-character cells.
 */
export function frameToHtml(
	cols: number,
	rows: string[],
	palette: Palette,
	label: string,
): string {
	return `<div class="frame" role="img" aria-label="${escapeHtml(label)}" style="width:${cols}ch;background:${palette.background};color:${palette.foreground}"><div aria-hidden="true">${rows.join('')}</div></div>`;
}

export const frameCss = `
.frame{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:13px;line-height:1.3;white-space:pre;overflow:hidden;padding:4px 6px;font-variant-ligatures:none}
.frame .row{display:flex;height:1.3em}
.frame b{display:flex;flex:none;font-weight:400}
.frame i{display:inline-block;flex:none;min-width:0;font-style:inherit;text-align:center;overflow:visible}
.frame i.w{overflow:hidden}
.frame i.w s{text-decoration:none;font-size:.86em}
`;
