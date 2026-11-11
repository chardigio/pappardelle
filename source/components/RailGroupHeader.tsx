import {memo} from 'react';
import type {MouseEvent, WidthMethod} from '@opentui/core';
import type {RailRow} from '../rail-groups.ts';
import {useAttentionFrame} from '../animation-clock.ts';
import {dimText} from '../tui-style.ts';
import {truncateToWidth} from '../truncate-to-width.ts';
import {displayWidth} from '../text-measure.ts';
import {useWidthMethod} from './use-width-method.ts';
import {resolveRowHighlight} from './row-highlight.ts';
import {ROW_PADDING_CELLS} from './SpaceListItem.tsx';

type HeaderRow = Extract<RailRow, {kind: 'header'}>;

interface Props {
	row: HeaderRow;
	isSelected: boolean;
	width: number;
	onToggle: (groupId: string, collapse: boolean) => void;
}

/**
 * The header label, fitted to `maxCells`. The name gives way before the count,
 * so a narrow rail still shows how many spaces a collapsed group holds.
 */
export function railGroupHeaderText(
	row: HeaderRow,
	maxCells: number,
	widthMethod: WidthMethod,
): string {
	const chevron = row.collapsed ? '▸ ' : '▾ ';
	const count = ` (${row.count})`;
	const nameCells =
		maxCells -
		displayWidth(chevron, widthMethod) -
		displayWidth(count, widthMethod);
	if (nameCells < 1) {
		return truncateToWidth(
			`${chevron}${row.group.name}${count}`,
			maxCells,
			widthMethod,
		);
	}

	return `${chevron}${truncateToWidth(row.group.name, nameCells, widthMethod)}${count}`;
}

function RailGroupHeader({row, isSelected, width, onToggle}: Props) {
	const needsAttention = row.attention !== null;
	const blinkOn = useAttentionFrame(needsAttention) % 2 === 0;
	const {paint} = resolveRowHighlight({
		isSelected,
		needsAttention,
		blinkOn,
		isQuestion: row.attention === 'question',
	});
	const gap = paint({});
	const widthMethod = useWidthMethod();
	const contentWidth = Math.max(0, width - 2 * ROW_PADDING_CELLS);

	const handleClick = (event: MouseEvent) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		onToggle(row.group.id, !row.collapsed);
	};

	return (
		<box
			flexDirection="row"
			overflow="hidden"
			height={1}
			onMouseDown={handleClick}
		>
			<text flexShrink={0} {...gap}>
				{' '.repeat(ROW_PADDING_CELLS)}
			</text>
			<text
				flexShrink={1}
				wrapMode="none"
				height={1}
				{...paint({fg: row.group.color, bold: true})}
			>
				{railGroupHeaderText(row, contentWidth, widthMethod)}
			</text>
			<text
				flexGrow={1}
				flexShrink={1}
				flexBasis={0}
				minWidth={0}
				wrapMode="none"
				height={1}
				{...gap}
			>
				{' '.repeat(width)}
			</text>
			<text flexShrink={0} {...gap}>
				{' '.repeat(ROW_PADDING_CELLS)}
			</text>
		</box>
	);
}

/** The rule between agent spaces (main) and the workspaces below them. */
export function RailDivider({width}: {width: number}) {
	return (
		<box flexDirection="row" overflow="hidden" height={1}>
			<text {...dimText()} wrapMode="none" height={1}>
				{' '.repeat(ROW_PADDING_CELLS) +
					'─'.repeat(Math.max(0, width - 2 * ROW_PADDING_CELLS))}
			</text>
		</box>
	);
}

export default memo(RailGroupHeader);
