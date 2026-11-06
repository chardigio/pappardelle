import type {BoxRenderable, OptimizedBuffer} from '@opentui/core';
import {useMemo, type ReactNode} from 'react';
import {terminalColor} from '../tui-style.ts';
import {paintFrame, type FrameSpec} from './frame-paint.ts';

/**
 * OpenTUI's box draws its border and title without text attributes, so it can
 * neither dim an unfocused frame nor bold the heading. The box keeps its border
 * for layout, and the frame is repainted over it with the attributes. Dimming
 * goes through SGR 2 on the palette color rather than opacity: opacity blends
 * toward black, which vanishes on dark themes and darkens on light ones.
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
}: {
	title: string;
	borderColor: string;
	titleColor: string;
	borderStyle?: 'double' | 'round';
	width: number;
	paddingY?: number;
	isDim?: boolean;
	children: ReactNode;
}) {
	const style = borderStyle === 'round' ? 'rounded' : borderStyle;
	const renderAfter = useMemo(() => {
		const spec: FrameSpec = {title, borderColor, titleColor, style, isDim};
		return function (this: BoxRenderable, buffer: OptimizedBuffer) {
			paintFrame(this, buffer, spec);
		};
	}, [title, borderColor, titleColor, style, isDim]);

	return (
		<box
			flexDirection="column"
			width={width}
			border
			borderStyle={style}
			borderColor={terminalColor(borderColor)}
			renderAfter={renderAfter}
			paddingX={2}
			paddingY={paddingY}
		>
			{children}
		</box>
	);
}
