import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import type {SpaceData} from '../types.ts';
import {CLAUDE_STATUS_DISPLAY, COLORS} from '../types.ts';
import {getMainWorktreeColor} from '../git-status.ts';
import {getWorkflowStateColor} from '../linear.ts';
import ClaudeAnimation from './ClaudeAnimation.tsx';

interface Props {
	space: SpaceData;
	isSelected: boolean;
	width: number;
}

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

	// Calculate available width for title
	// Format: "✢ STA-123 title..." or "✢ title..." (no issue key for pending description rows)
	const issueKey = space.name;
	const hasIssueKey = issueKey.length > 0;
	// icon (1) + space (1) [+ issueKey (variable) + space (1)]
	const fixedWidth = hasIssueKey ? 1 + 1 + issueKey.length + 1 : 1 + 1;
	const availableTitleWidth = Math.max(0, width - fixedWidth);

	// Truncate title (pending rows use their own title text)
	const title = space.pendingTitle ?? space.linearIssue?.title ?? '';
	const truncatedTitle =
		title.length > availableTitleWidth
			? title.slice(0, availableTitleWidth - 1) + '\u2026'
			: title;

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

	return (
		<Box>
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
		</Box>
	);
}
