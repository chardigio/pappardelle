import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import type {SpaceData} from '../types.js';
import {CLAUDE_STATUS_DISPLAY} from '../types.js';
import ClaudeAnimation from './ClaudeAnimation.js';

interface Props {
	space: SpaceData;
	isSelected: boolean;
	width: number;
}

export default function SpaceListItem({space, isSelected, width}: Props) {
	const statusInfo = space.claudeStatus
		? CLAUDE_STATUS_DISPLAY[space.claudeStatus]
		: CLAUDE_STATUS_DISPLAY.unknown;

	const isWorking =
		space.claudeStatus === 'thinking' || space.claudeStatus === 'tool_use';

	// Determine if row needs attention (blinking background)
	const needsAttention =
		space.claudeStatus === 'waiting_input' ||
		space.claudeStatus === 'waiting_permission';

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
	// Format: "> STA-123 ✢ title..."
	// selector (2) + issueKey (8 padded) + space (1) + icon (1) + space (1) = 13 chars fixed
	const issueKeyWidth = 8;
	const fixedWidth = 2 + issueKeyWidth + 1 + 1 + 1; // 13
	const availableTitleWidth = Math.max(0, width - fixedWidth);

	// Pad issue key to fixed width for alignment
	const paddedIssueKey = space.name.padEnd(issueKeyWidth);

	// Truncate title
	const title = space.linearIssue?.title ?? '';
	const truncatedTitle =
		title.length > availableTitleWidth
			? title.slice(0, availableTitleWidth - 1) + '\u2026'
			: title;

	// Linear state color (applied to issue key)
	// Each state has a distinct color for easy visual identification
	const getStateColor = (): string => {
		const state = space.linearIssue?.state;
		if (!state) return 'gray';
		if (state.type === 'completed') return 'green';
		if (state.type === 'started') {
			// "In Review" gets magentaBright to distinguish from "In Progress" (yellow)
			if (state.name === 'In Review') return 'magentaBright';
			return 'yellow';
		}
		return 'gray';
	};
	const stateColor = getStateColor();

	// When blinking, use inverse to make the row stand out
	const useInverse = needsAttention && blinkOn;
	const textColor = useInverse
		? space.claudeStatus === 'waiting_permission'
			? 'red'
			: 'blue'
		: undefined;

	return (
		<Box>
			{/* Selection indicator */}
			<Text
				color={isSelected && !useInverse ? 'white' : textColor}
				bold={isSelected}
				inverse={useInverse}
			>
				{isSelected ? '> ' : '  '}
			</Text>

			{/* Issue key (colored by Linear state, padded for alignment) */}
			<Text
				color={
					isSelected && !useInverse
						? 'white'
						: useInverse
							? textColor
							: stateColor
				}
				bold
				inverse={useInverse}
			>
				{paddedIssueKey}
			</Text>

			{/* Claude status indicator + label */}
			<Text inverse={useInverse} color={textColor}>
				{' '}
			</Text>
			{isWorking ? (
				<ClaudeAnimation color={statusInfo.color} />
			) : (
				<Text
					color={useInverse ? textColor : statusInfo.color}
					inverse={useInverse}
				>
					{statusInfo.icon ?? '?'}
				</Text>
			)}

			{/* Title (dimmed) */}
			<Text inverse={useInverse} color={textColor}>
				{' '}
			</Text>
			<Text
				dimColor={!useInverse}
				wrap="truncate"
				inverse={useInverse}
				color={textColor}
			>
				{truncatedTitle}
			</Text>
		</Box>
	);
}
