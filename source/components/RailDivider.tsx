import {memo, useMemo} from 'react';
import type {BoxRenderable, OptimizedBuffer} from '@opentui/core';
import {paintFrameRule} from './frame-paint.ts';
import {PANE_FRAME_STYLE} from './PaneFrame.tsx';

// Paints over the rail frame's sides on its row, which works because a
// child's renderAfter runs after its ancestors' have drawn the frame.
function RailDivider({isActive}: {isActive: boolean}) {
	const renderAfter = useMemo(
		() =>
			function (this: BoxRenderable, buffer: OptimizedBuffer) {
				paintFrameRule(this, buffer, {
					style: PANE_FRAME_STYLE,
					isDim: !isActive,
				});
			},
		[isActive],
	);
	return <box height={1} renderAfter={renderAfter} />;
}

export default memo(RailDivider);
