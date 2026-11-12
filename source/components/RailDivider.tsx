import {useMemo} from 'react';
import type {BoxRenderable, OptimizedBuffer} from '@opentui/core';
import {paintFrameRule} from './frame-paint.ts';

/**
 * The rule between agent spaces (main) and the workspaces below them, joined
 * to the rail's frame on both sides.
 */
export default function RailDivider({isActive}: {isActive: boolean}) {
	const renderAfter = useMemo(
		() =>
			function (this: BoxRenderable, buffer: OptimizedBuffer) {
				paintFrameRule(this, buffer, {style: 'rounded', isDim: !isActive});
			},
		[isActive],
	);
	return <box height={1} renderAfter={renderAfter} />;
}
