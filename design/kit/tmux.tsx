import type {ReactNode} from 'react';
import type {ColorInput} from '@opentui/core';
import stringWidth from 'string-width';
import {Line, type Seg} from './line.tsx';

export type Pane = {
	width: number;
	/** Rendered into the pane's top border, like `pane-border-status top`. */
	title: Seg[];
	active: boolean;
	content: ReactNode;
};

export type BorderLook = {
	/** Border glyph and style for the active and inactive panes. */
	active: Seg;
	inactive: Seg;
	/** `pane-border-lines`: the horizontal glyph used on the title rows. */
	horizontal: string;
	/** The separator between panes, and where it meets the title row. */
	vertical?: string;
	junction?: string;
};

/**
 * A tmux window drawn with OpenTUI: panes side by side, separated by the
 * one-column borders tmux draws, each with a title row on top and a status
 * line underneath. Only the drawing is mocked; the options that produce it
 * are listed per direction in `tmuxConf`.
 */
export function TmuxWindow({
	panes,
	border,
	status,
	cols,
	rows,
	statusBg,
}: {
	panes: Pane[];
	border: BorderLook;
	status: Seg[];
	cols: number;
	rows: number;
	statusBg?: ColorInput;
}) {
	const bodyRows = rows - 2;
	return (
		<box flexDirection="column" width={cols} height={rows}>
			<box flexDirection="row" height={1}>
				{panes.map((pane, index) => {
					const style = pane.active ? border.active : border.inactive;
					const titleCells = pane.title.reduce(
						(sum, seg) => sum + stringWidth(seg.text),
						0,
					);
					return (
						<box key={index} flexDirection="row">
							{index > 0 && (
								<Line
									cols={1}
									segs={[
										{...style, text: border.junction ?? border.horizontal},
									]}
								/>
							)}
							<Line
								cols={pane.width}
								segs={[
									{...style, text: border.horizontal},
									...pane.title,
									{
										...style,
										text: border.horizontal.repeat(
											Math.max(0, pane.width - 1 - titleCells),
										),
									},
								]}
							/>
						</box>
					);
				})}
			</box>
			<box flexDirection="row" height={bodyRows}>
				{panes.map((pane, index) => {
					const separatorActive = pane.active || panes[index - 1]?.active;
					const style = separatorActive ? border.active : border.inactive;
					return (
						<box key={index} flexDirection="row">
							{index > 0 && (
								<box flexDirection="column" width={1}>
									{Array.from({length: bodyRows}, (_, row) => (
										<Line
											key={row}
											cols={1}
											segs={[{...style, text: border.vertical ?? '│'}]}
										/>
									))}
								</box>
							)}
							<box width={pane.width} height={bodyRows} overflow="hidden">
								{pane.content}
							</box>
						</box>
					);
				})}
			</box>
			<Line cols={cols} segs={status} bg={statusBg} />
		</box>
	);
}

/** Splits a window width the way pappardelle's horizontal layout does. */
export function paneWidths(
	cols: number,
	railCols: number,
): [number, number, number] {
	const rest = cols - railCols - 2;
	const agent = Math.round(rest * 0.56);
	return [railCols, agent, rest - agent];
}
