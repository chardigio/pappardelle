import type {ReactNode} from 'react';
import type {ColorInput} from '@opentui/core';
import stringWidth from 'string-width';
import {Line, type Seg} from './line.tsx';

export type PanelChars = {
	tl: string;
	tr: string;
	bl: string;
	br: string;
	h: string;
	v: string;
	/** Optional distinct glyph for the bottom edge (torn or perforated). */
	bottom?: string;
};

export const ROUNDED: PanelChars = {
	tl: '╭',
	tr: '╮',
	bl: '╰',
	br: '╯',
	h: '─',
	v: '│',
};

const NO_SEGS: Seg[] = [];

/** Columns left for content inside a Panel: the two borders and padding. */
export const panelInner = (cols: number, paddingX = 2) =>
	cols - 2 - paddingX * 2;

const cells = (segs: Seg[]) =>
	segs.reduce((sum, seg) => sum + stringWidth(seg.text), 0);

/**
 * A border drawn from text cells instead of OpenTUI's box border, so it can
 * carry text attributes. That matters in 16 colors: `dim` recedes on every
 * theme, while the usual alternative, ANSI gray, is the background color in
 * Solarized Dark.
 */
export function Panel({
	cols,
	rows,
	border,
	chars = ROUNDED,
	title = NO_SEGS,
	bottomTitle = NO_SEGS,
	paddingX = 2,
	paddingY = 1,
	bg,
	children,
}: {
	cols: number;
	rows: number;
	border: Seg;
	chars?: PanelChars;
	title?: Seg[];
	bottomTitle?: Seg[];
	paddingX?: number;
	paddingY?: number;
	bg?: ColorInput;
	children: ReactNode;
}) {
	const edge = (text: string): Seg => ({...border, text});
	const bottomGlyph = chars.bottom ?? chars.h;
	const top: Seg[] = [
		edge(chars.tl + chars.h),
		...title,
		edge(chars.h.repeat(Math.max(0, cols - 3 - cells(title))) + chars.tr),
	];
	const bottom: Seg[] = [
		edge(
			chars.bl + bottomGlyph.repeat(Math.max(0, cols - 3 - cells(bottomTitle))),
		),
		...bottomTitle,
		edge(bottomGlyph + chars.br),
	];
	const inner = rows - 2;
	return (
		<box flexDirection="column" width={cols} height={rows}>
			<Line cols={cols} segs={top} bg={bg} />
			<box flexDirection="row" height={inner}>
				<box flexDirection="column" width={1}>
					{Array.from({length: inner}, (_, row) => (
						<Line key={row} cols={1} segs={[edge(chars.v)]} bg={bg} />
					))}
				</box>
				<box
					width={cols - 2}
					height={inner}
					paddingX={paddingX}
					paddingY={paddingY}
					backgroundColor={bg}
					flexDirection="column"
					overflow="hidden"
				>
					{children}
				</box>
				<box flexDirection="column" width={1}>
					{Array.from({length: inner}, (_, row) => (
						<Line key={row} cols={1} segs={[edge(chars.v)]} bg={bg} />
					))}
				</box>
			</box>
			<Line cols={cols} segs={bottom} bg={bg} />
		</box>
	);
}
