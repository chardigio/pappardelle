import type {BorderStyle, BoxRenderable, OptimizedBuffer} from '@opentui/core';
import {useMemo, type ReactNode} from 'react';
import {paintFrame, type FrameSpec} from './frame-paint.ts';

/** Rows and columns the frame's border takes from the pane. */
export const PANE_FRAME_SIZE = 2;

export const PANE_FRAME_STYLE: BorderStyle = 'rounded';

/**
 * The rounded, titled frame the rail draws its boxes with, matching the frames
 * the viewer panes' frame hosts draw. It dims while the pane is not focused.
 * A growing frame takes the height its siblings leave; otherwise it fits
 * its content.
 */
export default function PaneFrame({
	title,
	trailing,
	isActive,
	isGrowing = false,
	children,
}: {
	title: FrameSpec['title'];
	trailing?: string;
	isActive: boolean;
	isGrowing?: boolean;
	children: ReactNode;
}) {
	const renderAfter = useMemo(
		() =>
			function (this: BoxRenderable, buffer: OptimizedBuffer) {
				paintFrame(this, buffer, {
					title,
					trailing,
					style: PANE_FRAME_STYLE,
					isDim: !isActive,
					inset: 1,
				});
			},
		[title, trailing, isActive],
	);
	return (
		<box
			flexDirection="column"
			width="100%"
			flexGrow={isGrowing ? 1 : 0}
			flexShrink={isGrowing ? 1 : 0}
			border
			borderStyle={PANE_FRAME_STYLE}
			renderAfter={renderAfter}
		>
			{children}
		</box>
	);
}
