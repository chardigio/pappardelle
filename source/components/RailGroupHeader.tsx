import {memo} from 'react';
import type {WidthMethod} from '@opentui/core';
import type {RailRow} from '../rail-groups.ts';
import {dimText, terminalColor, textAttributes} from '../tui-style.ts';
import {truncateToWidth} from '../truncate-to-width.ts';
import {displayWidth} from '../text-measure.ts';
import {useWidthMethod} from './use-width-method.ts';
import {ROW_PADDING_CELLS} from './SpaceListItem.tsx';

type HeaderRow = Extract<RailRow, {kind: 'header'}>;

interface Props {
	row: HeaderRow;
	width: number;
}

/**
 * The header label, fitted to `maxCells`. The name gives way before the count,
 * so a narrow rail still shows how many spaces a group holds.
 */
export function railGroupHeaderText(
	row: HeaderRow,
	maxCells: number,
	widthMethod: WidthMethod,
): {name: string; count: string} {
	const count = ` (${row.count})`;
	const nameCells = maxCells - displayWidth(count, widthMethod);
	if (nameCells < 1) {
		return {
			name: truncateToWidth(`${row.group.name}${count}`, maxCells, widthMethod),
			count: '',
		};
	}

	return {
		name: truncateToWidth(row.group.name, nameCells, widthMethod),
		count,
	};
}

function RailGroupHeader({row, width}: Props) {
	const widthMethod = useWidthMethod();
	const contentWidth = Math.max(0, width - 2 * ROW_PADDING_CELLS);
	const {name, count} = railGroupHeaderText(row, contentWidth, widthMethod);

	return (
		<box flexDirection="row" overflow="hidden" height={1}>
			<text flexShrink={0}>{' '.repeat(ROW_PADDING_CELLS)}</text>
			<text
				flexShrink={1}
				wrapMode="none"
				height={1}
				fg={terminalColor(row.group.color)}
				attributes={textAttributes({bold: true})}
			>
				{name}
			</text>
			<text {...dimText()} flexShrink={0} wrapMode="none" height={1}>
				{count}
			</text>
		</box>
	);
}

export default memo(RailGroupHeader);
