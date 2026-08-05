import React, {type ReactNode} from 'react';
import {Box, Text} from 'ink';
import {buildTitledBorderTop} from './titled-border.ts';

type Props = {
	title: string;
	borderColor: string;
	/**
	 * Heading color. Required, and it should differ from `borderColor` — see the
	 * comment on the top row below for why inheriting the frame's color breaks.
	 */
	titleColor: string;
	borderStyle?: 'double' | 'round';
	/** Fixed outer width, in cells. Required — the hand-drawn top edge can't flex. */
	width: number;
	/** Blank rows inside the top and bottom edges. */
	paddingY?: number;
	/** Render the frame and heading dimmed — used to mark an unfocused box. */
	isDim?: boolean;
	children: ReactNode;
};

/**
 * A bordered box whose heading sits inside the top edge.
 *
 * The top rule is drawn by hand (see `titled-border.ts`) and the box below it
 * omits its own top border, so the two halves read as one frame. That means the
 * width can't be intrinsic the way a plain `<Box borderStyle>` is — callers must
 * pass an explicit `width`, and every child has to fit it.
 */
export default function TitledBox({
	title,
	borderColor,
	titleColor,
	borderStyle = 'double',
	width,
	paddingY = 1,
	isDim = false,
	children,
}: Props) {
	const {prefix, label, suffix} = buildTitledBorderTop(
		title,
		width,
		borderStyle,
	);

	return (
		<Box flexDirection="column" width={width}>
			{/*
			 * Give the heading a color of its own rather than letting it inherit
			 * the frame's. Ink elides an SGR it believes is already open, so a
			 * heading painted the same color as the corner beside it ships as a
			 * bare `ESC[1m` run — correct, but renderers that reset the
			 * foreground on a bold-only run (`freeze`, some terminals) then draw
			 * it uncolored. An explicit color is always emitted.
			 */}
			<Box flexDirection="row" width={width}>
				<Text color={borderColor} dimColor={isDim}>
					{prefix}
				</Text>
				{label ? (
					<Text bold color={titleColor} dimColor={isDim}>
						{label}
					</Text>
				) : null}
				<Text color={borderColor} dimColor={isDim}>
					{suffix}
				</Text>
			</Box>
			{/*
			 * `key` forces a fresh node whenever the border style changes, and it is
			 * load-bearing: Ink's `applyBorderStyles` guards its top-edge reset with
			 * `if (style.borderTop !== false)`, so a box like this one — which always
			 * sets `borderTop={false}` — never gets `setBorder(EDGE_TOP, …)` called
			 * on restyle. Flip `borderStyle` on the surviving Yoga node and it keeps
			 * a stale 1-cell top inset, which paints as a blank row between the
			 * hand-drawn top rule and the first child. Remounting sidesteps it.
			 * Only reproduces on a *transition*, so static render tests miss it.
			 */}
			<Box
				key={borderStyle}
				flexDirection="column"
				width={width}
				borderStyle={borderStyle}
				borderColor={borderColor}
				borderDimColor={isDim}
				borderTop={false}
				paddingX={2}
				paddingY={paddingY}
			>
				{children}
			</Box>
		</Box>
	);
}
