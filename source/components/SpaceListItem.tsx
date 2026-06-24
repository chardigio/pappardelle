import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import type {PipelineStatus, SpaceData} from '../types.ts';
import {CLAUDE_STATUS_DISPLAY, COLORS} from '../types.ts';
import {getMainWorktreeColor} from '../git-status.ts';
import {getWorkflowStateColor} from '../tracker.ts';
import {shouldShowLoadingTitle} from '../space-utils.ts';
import {railPrefixWidth, rowPrefixWidth} from '../list-view-sizing.ts';
import {inkRenderPad, railEmojiIsInkPadded} from '../emoji-rail-width.ts';
import {truncateToWidth} from '../truncate-to-width.ts';
import ClaudeAnimation from './ClaudeAnimation.tsx';

interface Props {
	space: SpaceData;
	isSelected: boolean;
	width: number;
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

export default function SpaceListItem({space, isSelected, width}: Props) {
	const baseStatusInfo = space.claudeStatus
		? CLAUDE_STATUS_DISPLAY[space.claudeStatus]
		: CLAUDE_STATUS_DISPLAY.unknown;

	// AskUserQuestion is a question (blue '?'), not a permission approval (red '!')
	const isQuestion =
		space.claudeStatus === 'waiting_for_approval' &&
		space.claudeTool === 'AskUserQuestion';

	const statusInfo = isQuestion ? {color: 'blue', icon: '?'} : baseStatusInfo;

	// Pending rows always show the animation spinner
	const isWorking =
		space.isPending ||
		space.claudeStatus === 'processing' ||
		space.claudeStatus === 'running_tool';

	// Determine if row needs attention (blinking background)
	// Both approval requests and questions blink, but with different colors
	const needsAttention = space.claudeStatus === 'waiting_for_approval';

	// Blink state for rows that need attention
	const [blinkOn, setBlinkOn] = useState(true);
	useEffect(() => {
		if (!needsAttention) {
			setBlinkOn(true);
			return;
		}
		const interval = setInterval(() => {
			setBlinkOn(prev => !prev);
		}, 500); // 500ms on/off for noticeable but not annoying blink
		return () => clearInterval(interval);
	}, [needsAttention]);

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
	//   - "🎸" / "🐝" / etc.: render the glyph, measuring with string-width
	//     so multi-cell emoji reserve the right number of cells.
	const rawEmoji = space.profileEmoji;
	const hasEmojiSlot = rawEmoji !== undefined;
	const emoji = hasEmojiSlot ? (rawEmoji === '' ? '  ' : rawEmoji) : undefined;
	const emojiCells = emoji ? stringWidth(emoji) : 0;
	const emojiPrefixCells = rowPrefixWidth(
		emoji ? {emoji, width: emojiCells} : undefined,
	);
	// Whether to emit our own separator space after the emoji. For most emoji
	// we do — but for single-BMP default-emoji symbols (✨ ⭐ ✅ …) Ink draws
	// the glyph one cell narrower than `string-width` reserved and pads the box
	// with a trailing space. That pad already separates the emoji from the
	// status icon, so emitting a second space here would double it (STA-1565).
	const emojiNeedsSeparator = emoji ? !railEmojiIsInkPadded(emoji) : false;

	// Calculate available width for title
	// Format: "[emoji ] ✢ STA-123 title…   [pipeline] [(N)]" — emoji on the
	// far left, rail icons right-aligned. They reserve space by shrinking
	// the title budget.
	const issueKey = space.name;
	const hasIssueKey = issueKey.length > 0;
	// emoji prefix + icon (1) + space (1) [+ issueKey (variable) + space (1)] + rail suffix
	const fixedWidth =
		emojiPrefixCells +
		(hasIssueKey ? 1 + 1 + issueKey.length + 1 : 1 + 1) +
		prefixCells;
	const availableTitleWidth = Math.max(0, width - fixedWidth);

	// Truncate title (pending rows use their own title text)
	// Show "Loading…" while the Linear issue title is being fetched
	const title =
		space.pendingTitle ??
		space.linearIssue?.title ??
		(shouldShowLoadingTitle(space) ? 'Loading…' : '');
	// The crux of STA-1565. A bare-BMP default-emoji symbol (✨ ⭐ ✅) is laid
	// out by Ink one cell narrower than the terminal actually renders it, so the
	// terminal expands every such glyph by a cell *beyond* Ink's layout — both
	// in the prefix and anywhere in the title. Two consequences, both handled
	// here:
	//   1. Truncate the title by *display width* (`truncateToWidth`), not UTF-16
	//      code units, then trim it the extra cell each kept emoji will expand by
	//      so it still fits its budget once rendered.
	//   2. Shrink the whole row by the row's total expansion (`rowInkPad`) so the
	//      right-aligned rail anchors that many columns in from the edge. Without
	//      this the rail's flex spacer refills to the full width in Ink's model
	//      and the terminal expansion pushes the rail icons onto the next line.
	const prefixInkPad = emoji ? inkRenderPad(emoji) : 0;
	let truncatedTitle = truncateToWidth(
		title,
		availableTitleWidth - prefixInkPad,
	);
	const firstTitleInkPad = inkRenderPad(truncatedTitle);
	if (firstTitleInkPad > 0) {
		truncatedTitle = truncateToWidth(
			title,
			availableTitleWidth - prefixInkPad - firstTitleInkPad,
		);
	}
	const rowInkPad = prefixInkPad + inkRenderPad(truncatedTitle);
	// Width the row's outer Box is given. Equals `width` when nothing expands
	// (byte-identical to master), otherwise `width − rowInkPad` so the terminal
	// expansion fills the row exactly to the pane edge instead of past it.
	const rowWidth = rowInkPad > 0 ? Math.max(0, width - rowInkPad) : undefined;

	// Linear state color (applied to issue key)
	// Uses the exact color from Linear's API so pappardelle always matches
	const getStateColor = (): string => {
		if (space.isMainWorktree) {
			return getMainWorktreeColor(
				space.isDirty ?? false,
				getWorkflowStateColor('In Progress') ?? 'gray',
				getWorkflowStateColor('Done') ?? 'gray',
			);
		}

		const state = space.linearIssue?.state;
		if (!state) return space.isPending ? 'white' : 'gray';
		return state.color;
	};
	const stateColor = getStateColor();

	// Determine highlight mode:
	// - needsAttention + blinkOn: blink color (blue for question, red for approval)
	// - isSelected (and not blinking): white background via inverse
	// - needsAttention + isSelected + !blinkOn: white background (blink off-phase)
	const useBlinkInverse = needsAttention && blinkOn;
	const useSelectionInverse = isSelected && !useBlinkInverse;
	const useInverse = useBlinkInverse || useSelectionInverse;
	const textColor = useBlinkInverse ? (isQuestion ? 'blue' : 'red') : undefined;

	const renderPipelineIcon = () => {
		if (!pipeline) return null;
		if (pipeline === 'progressing_dirty') {
			return (
				<>
					<Text inverse={useBlinkInverse} color={textColor}>
						{' '}
					</Text>
					<Text
						bold
						color={useBlinkInverse ? textColor : 'yellow'}
						inverse={useBlinkInverse}
					>
						◐
					</Text>
					<Text
						bold
						color={useBlinkInverse ? textColor : 'red'}
						inverse={useBlinkInverse}
					>
						◑
					</Text>
				</>
			);
		}

		const style = PIPELINE_SINGLE[pipeline];
		return (
			<>
				<Text inverse={useBlinkInverse} color={textColor}>
					{' '}
				</Text>
				<Text
					bold
					color={useBlinkInverse ? textColor : style.color}
					inverse={useBlinkInverse}
				>
					{style.icon}
				</Text>
			</>
		);
	};

	const renderCommentCount = () => {
		if (commentCount <= 0) return null;
		return (
			<>
				<Text inverse={useBlinkInverse} color={textColor}>
					{' '}
				</Text>
				<Text
					color={useBlinkInverse ? textColor : 'gray'}
					inverse={useBlinkInverse}
				>
					{`(${commentCount})`}
				</Text>
			</>
		);
	};

	const renderConflictIcon = () => {
		if (!hasConflict) return null;
		return (
			<>
				<Text inverse={useBlinkInverse} color={textColor}>
					{' '}
				</Text>
				<Text
					bold
					color={useBlinkInverse ? textColor : 'red'}
					inverse={useBlinkInverse}
				>
					↯
				</Text>
			</>
		);
	};

	return (
		<Box width={rowWidth}>
			{/* Profile emoji (NOT highlighted) — first cell on the row when set.
			    Followed by a single space separator so it doesn't crash into the
			    Claude status icon. */}
			{emoji ? (
				<>
					<Text inverse={useBlinkInverse} color={textColor}>
						{emoji}
					</Text>
					{emojiNeedsSeparator ? (
						<Text inverse={useBlinkInverse} color={textColor}>
							{' '}
						</Text>
					) : null}
				</>
			) : null}
			{/* Status icon (NOT highlighted, always shows its own color) */}
			{isWorking ? (
				<ClaudeAnimation
					color={
						useBlinkInverse
							? textColor
							: space.isPending
								? COLORS.CLAUDE_ORANGE
								: statusInfo.color
					}
					inverse={useBlinkInverse}
				/>
			) : (
				<Text
					color={useBlinkInverse ? textColor : statusInfo.color}
					inverse={useBlinkInverse}
				>
					{statusInfo.icon ?? '?'}
				</Text>
			)}

			{/* Space after status icon (NOT highlighted) */}
			<Text inverse={useBlinkInverse} color={textColor}>
				{' '}
			</Text>

			{/* Issue key badge (colored by Linear state, highlighted when selected) */}
			{hasIssueKey && (
				<Text
					color={useBlinkInverse ? textColor : stateColor}
					bold
					inverse={useInverse}
				>
					{issueKey}
				</Text>
			)}

			{/* Space + title (only if there's a title to show) */}
			{truncatedTitle.length > 0 && (
				<>
					{hasIssueKey && (
						<Text
							dimColor={!useInverse}
							inverse={useInverse}
							color={useSelectionInverse ? stateColor : textColor}
						>
							{' '}
						</Text>
					)}
					<Text
						dimColor={!useInverse}
						wrap="truncate"
						inverse={useInverse}
						color={useSelectionInverse ? stateColor : textColor}
					>
						{truncatedTitle}
					</Text>
				</>
			)}

			{/* Rail icons — right-aligned: unresolved comment count, then the
			    merge-conflict indicator, then pipeline state flush at the far
			    right. Pushed right by a flex spacer that consumes whatever
			    leftover width remains. */}
			{pipeline !== null || commentCount > 0 || hasConflict ? (
				<Box flexGrow={1} justifyContent="flex-end">
					{renderCommentCount()}
					{renderConflictIcon()}
					{renderPipelineIcon()}
				</Box>
			) : null}
		</Box>
	);
}
