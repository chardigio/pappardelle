import type {BorderStyle, BoxRenderable, OptimizedBuffer} from '@opentui/core';
import {useMemo, type ReactNode} from 'react';
import {paintFrame} from './frame-paint.ts';

/** Rows and columns the frame's border takes from the pane. */
export const PANE_FRAME_SIZE = 2;

export const PANE_FRAME_STYLE: BorderStyle = 'rounded';

/**
 * The rounded, titled frame around a whole pane, matching the frames the
 * viewer panes' frame hosts draw. It dims while the pane is not focused.
 */
export default function PaneFrame({
	title,
	isActive,
	children,
}: {
	title: string;
	isActive: boolean;
	children: ReactNode;
}) {
	const renderAfter = useMemo(
		() =>
			function (this: BoxRenderable, buffer: OptimizedBuffer) {
				paintFrame(this, buffer, {
					title,
					style: PANE_FRAME_STYLE,
					isDim: !isActive,
					inset: 1,
				});
			},
		[title, isActive],
	);
	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			border
			borderStyle={PANE_FRAME_STYLE}
			renderAfter={renderAfter}
		>
			{children}
		</box>
	);
}
