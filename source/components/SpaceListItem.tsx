import {memo} from 'react';
import type {MouseEvent} from '@opentui/core';

import type {PipelineStatus, SpaceData} from '../types.ts';
import {COLORS} from '../types.ts';
import {programStatusDisplay} from '../program-status-display.ts';
import {getMainWorktreeColor} from '../git-status.ts';
import {getWorkflowStateColor} from '../tracker.ts';
import {resolveStateColor} from '../state-color-override.ts';
import {spaceAttention} from '../rail-groups.ts';
import {shouldShowLoadingTitle} from '../space-utils.ts';
import {
	clipIssueKey,
	railPrefixWidth,
	rowPrefixWidth,
	ROW_ICON_CELLS,
	STATUS_ICON_CELLS,
	twoLineTitleIndent,
	titleSharesKeyLine,
} from '../list-view-sizing.ts';
import {resolveEmojiSlot} from '../emoji-rail-width.ts';
import {maybeStripSkinTones, useTmuxSkinToneWide} from '../tmux-skin-tone.ts';
import {truncateToWidth} from '../truncate-to-width.ts';
import {displayWidth} from '../text-measure.ts';
import type {ListLayout} from '../config.ts';
import {resolveRowHighlight} from './row-highlight.ts';
import ClaudeAnimation from './ClaudeAnimation.tsx';
import {useWidthMethod} from './use-width-method.ts';
import {useAttentionFrame} from '../animation-clock.ts';

/** Cells of highlight kept at each end of a row. */
export const ROW_PADDING_CELLS = 1;

interface Props {
	space: SpaceData;
	isSelected: boolean;
	width: number;
	layout: ListLayout;
	/** Shown in place of the space's key. */
	label?: string;
	onSelect?: (name: string) => void;
}

interface PipelineIconStyle {
	color: string;
	icon: string;
}

/** Single-color pipeline icons. `progressing_dirty` is rendered specially
 *  (two chars, two colors) and intentionally not in this map. */
const PIPELINE_SINGLE: Record<
	Exclude<PipelineStatus, 'progressing_dirty'>,
	PipelineIconStyle
> = {
	passing: {color: 'green', icon: '✓'}, // ✓
	failing: {color: 'red', icon: '✗'}, // ✗
	progressing_clean: {color: 'yellow', icon: '◔'}, // ◔
};

function SpaceListItem({
	space,
	isSelected,
	width,
	layout,
	label,
	onSelect,
}: Props) {
	const handleClick = (event: MouseEvent) => {
		if (event.button === 0 && !space.isPending) {
			event.stopPropagation();
			onSelect?.(space.name);
		}
	};
	const isTwoLine = layout === 'two_line';
	const inlineTitle = titleSharesKeyLine({
		isTwoLine,
		isPending: space.isPending,
	});
	const statusInfo = programStatusDisplay(space.programStatus);
	const attention = spaceAttention(space);
	const isQuestion = attention === 'question';

	// Pending rows always show the animation spinner
	const isWorking =
		space.isPending ||
		(space.programStatus?.status === 'working' &&
			space.programStatus.activity !== 'compacting');

	// Both approval requests and questions blink, but with different colors
	const needsAttention = attention !== null;

	const blinkOn = useAttentionFrame(needsAttention) % 2 === 0;
	const skinToneWide = useTmuxSkinToneWide();
	const widthMethod = useWidthMethod();

	// Rail icons: only meaningful when the branch has an open PR. When
	// `pipeline` is null (no PR, or fetch failed), both the pipeline icon and
	// the comment icon are hidden — even if a stale unresolvedCommentCount
	// lingered from a previous fetch.
	const pipeline = space.railStatus?.pipeline ?? null;
	const commentCount =
		pipeline === null ? 0 : (space.railStatus?.unresolvedCommentCount ?? 0);
	// Conflict indicator only meaningful when there's an open PR (pipeline !== null).
	const hasConflict =
		pipeline === null ? false : (space.railStatus?.hasConflict ?? false);
	const pipelineToken = pipeline
		? pipeline === 'progressing_dirty'
			? '◐◑'
			: PIPELINE_SINGLE[pipeline].icon
		: '';
	const prefixCells = railPrefixWidth({
		pipelineIcon: pipelineToken,
		commentCount,
		hasConflict,
	});

	// Optional profile emoji rendered to the left of the Claude status icon.
	//
	// Three states:
	//   - undefined: user has no emoji config at all → render no prefix,
	//     keeping the row visually identical to master.
	//   - "" (empty string): emoji slot is configured but blank → render
	//     two spaces so rows still line up with their emoji-bearing siblings.
	//   - "🎸" / "🐝" / etc.: render the glyph, measured the way the title
	//     beside it is, so multi-cell emoji reserve the right number of cells.
	const emojiSlot = resolveEmojiSlot(
		maybeStripSkinTones(space.profileEmoji, skinToneWide),
	);
	const emoji = emojiSlot?.text;
	const emojiCells = emoji ? displayWidth(emoji, widthMethod) : 0;
	const emojiPrefixCells = rowPrefixWidth(
		emoji ? {emoji, width: emojiCells} : undefined,
	);
	const emojiNeedsSeparator = emojiSlot?.needsSeparator ?? false;

	// A highlighted cell at each end keeps the emoji and the rail icons off the
	// edges of the selection bar.
	const contentWidth = Math.max(0, width - 2 * ROW_PADDING_CELLS);

	// The status icon must stay visible like the rail icons do, so on a rail
	// too narrow for the emoji, the status icon and the rail icons together,
	// the key line drops the emoji.
	const keyLineEmoji =
		emojiPrefixCells + STATUS_ICON_CELLS + prefixCells <= contentWidth
			? emoji
			: undefined;
	const keyLineEmojiCells = keyLineEmoji ? emojiPrefixCells : 0;

	// Calculate available width for title
	// Format: "[emoji ] ✢ STA-123 title…   [pipeline] [(N)]", with emoji on the
	// far left, rail icons right-aligned. They reserve space by shrinking
	// the title budget.
	// A hand-narrowed rail (STA-2040) can leave fewer columns than the key
	// needs. Clip it there, because an unclipped key wraps onto a second line
	// and breaks the one-row-per-space alignment. At every ordinary width the
	// clip is a no-op and the row is identical to master.
	//
	// `prefixCells` comes out of the budget too. Those rail icons are
	// right-aligned in a flex box after the title, so a key that consumed the
	// columns they need would push them off the row and wrap it again, which is
	// the very thing the clip exists to prevent.
	const issueKey = clipIssueKey(
		label ?? space.name,
		contentWidth - keyLineEmojiCells - ROW_ICON_CELLS - prefixCells,
	);
	const hasIssueKey = issueKey.length > 0;
	// emoji prefix + icon (1) + space (1) [+ issueKey (variable) + space (1)] + rail suffix
	const fixedWidth =
		keyLineEmojiCells +
		(hasIssueKey ? 1 + 1 + issueKey.length + 1 : 1 + 1) +
		prefixCells;
	const twoLineIndent = twoLineTitleIndent(
		keyLineEmoji ? {emoji: keyLineEmoji, width: emojiCells} : undefined,
	);
	const availableTitleWidth = inlineTitle
		? Math.max(0, contentWidth - fixedWidth)
		: Math.max(0, contentWidth - twoLineIndent);

	// Truncate title (pending rows use their own title text)
	// Show "Loading…" while the Linear issue title is being fetched
	const title =
		space.pendingTitle ??
		space.linearIssue?.title ??
		(shouldShowLoadingTitle(space) ? 'Loading…' : '');
	const truncatedTitle = truncateToWidth(
		maybeStripSkinTones(title, skinToneWide),
		availableTitleWidth,
		widthMethod,
	);

	// Issue state color (applied to issue key).
	// Uses the exact color from the tracker's API so pappardelle always matches,
	// unless the user listed this state in `state_colors:` — see STA-2070. The
	// main-worktree branch below is deliberately left on raw tracker colors.
	const getStateColor = (): string | undefined => {
		if (space.isMainWorktree) {
			return getMainWorktreeColor(
				space.isDirty ?? false,
				getWorkflowStateColor('In Progress') ?? 'gray',
				getWorkflowStateColor('Done') ?? 'gray',
			);
		}

		const state = space.linearIssue?.state;
		if (!state) return undefined;
		return resolveStateColor(state.name, state.color);
	};
	const stateColor = getStateColor();

	const {paint} = resolveRowHighlight({
		isSelected,
		needsAttention,
		blinkOn,
		isQuestion,
	});
	const gap = paint({});
	// Ends the left text, so it fills whatever the icons leave and carries the
	// highlight to them, and gives way first when the row is narrower than
	// `width`. Spaces past the room it is given are clipped.
	const filler = <span {...gap}>{' '.repeat(width)}</span>;
	const edgePad = <span {...gap}>{' '.repeat(ROW_PADDING_CELLS)}</span>;
	const titleSpan = <span {...paint({dim: true})}>{truncatedTitle}</span>;

	const left = (
		<text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" height={1}>
			{edgePad}
			{keyLineEmoji ? (
				<span {...gap}>
					{emojiNeedsSeparator ? `${keyLineEmoji} ` : keyLineEmoji}
				</span>
			) : null}
			{isWorking ? (
				<ClaudeAnimation
					paint={paint({
						fg: space.isPending ? COLORS.CLAUDE_ORANGE : statusInfo.color,
						keepsColor: true,
					})}
				/>
			) : (
				<span {...paint({fg: statusInfo.color, dim: statusInfo.dim})}>
					{statusInfo.icon ?? '?'}
				</span>
			)}
			<span {...gap}> </span>
			{hasIssueKey ? (
				<span {...paint({fg: stateColor, bold: true})}>{issueKey}</span>
			) : null}
			{inlineTitle && truncatedTitle.length > 0 ? (
				<>
					{hasIssueKey ? <span {...paint({dim: true})}> </span> : null}
					{titleSpan}
				</>
			) : null}
			{filler}
		</text>
	);

	// Rail icons, right-aligned: unresolved comment count, then the
	// merge-conflict indicator, then pipeline state flush at the far right.
	// The text never shrinks, so a row narrower than `width` clips its left
	// text and keeps these.
	const right = (
		<text flexShrink={0} wrapMode="none" height={1}>
			{commentCount > 0 ? (
				<>
					<span {...gap}> </span>
					<span {...paint({dim: true})}>{`(${commentCount})`}</span>
				</>
			) : null}
			{hasConflict ? (
				<>
					<span {...gap}> </span>
					<span {...paint({fg: 'red', bold: true})}>↯</span>
				</>
			) : null}
			{pipeline === 'progressing_dirty' ? (
				<>
					<span {...gap}> </span>
					<span {...paint({fg: 'yellow', bold: true})}>◐</span>
					<span {...paint({fg: 'red', bold: true})}>◑</span>
				</>
			) : pipeline ? (
				<>
					<span {...gap}> </span>
					<span {...paint({fg: PIPELINE_SINGLE[pipeline].color, bold: true})}>
						{PIPELINE_SINGLE[pipeline].icon}
					</span>
				</>
			) : null}
			{edgePad}
		</text>
	);

	const keyLine = (
		<box
			flexDirection="row"
			overflow="hidden"
			onMouseDown={isTwoLine ? undefined : handleClick}
		>
			{left}
			{right}
		</box>
	);

	if (!isTwoLine) return keyLine;

	// The second line is the title's, indented under the key. A pending row put
	// its title on the key line already, so its second line is blank padding —
	// still emitted, because every row has to be the same height.
	return (
		<box flexDirection="column" onMouseDown={handleClick}>
			{keyLine}
			<box flexDirection="row" overflow="hidden">
				<text
					flexGrow={1}
					flexShrink={1}
					minWidth={0}
					wrapMode="none"
					height={1}
				>
					<span {...gap}>{' '.repeat(ROW_PADDING_CELLS + twoLineIndent)}</span>
					{inlineTitle ? null : titleSpan}
					{filler}
				</text>
			</box>
		</box>
	);
}

export default memo(SpaceListItem);
