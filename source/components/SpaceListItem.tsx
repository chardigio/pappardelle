import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import type {SpaceData} from '../types.js';
import {CLAUDE_STATUS_DISPLAY} from '../types.js';
import {getMainWorktreeColor} from '../git-status.js';
import {getWorkflowStateColor} from '../linear.js';
import ClaudeAnimation from './ClaudeAnimation.js';

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

	const isWorking =
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
	// Format: "✢ STA-123 title..."
	// icon (1) + space (1) + issueKey (variable) + space (1) = 3 + key length
	const issueKey = space.name;
	const fixedWidth = 1 + 1 + issueKey.length + 1;
	const availableTitleWidth = Math.max(0, width - fixedWidth);

	// Truncate title
	const title = space.linearIssue?.title ?? '';
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
		if (!state) return 'gray';
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
					color={useBlinkInverse ? textColor : statusInfo.color}
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
			<Text
				color={useBlinkInverse ? textColor : stateColor}
				bold
				inverse={useInverse}
			>
				{issueKey}
			</Text>

			{/* Space + title (only if there's a title to show) */}
			{truncatedTitle.length > 0 && (
				<>
					<Text
						dimColor={!useInverse}
						inverse={useInverse}
						color={useSelectionInverse ? stateColor : textColor}
					>
						{' '}
					</Text>
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
