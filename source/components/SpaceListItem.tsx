import React from 'react';
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

	// Calculate available width for title
	// Format: "> STA-123 [status] title..."
	// selector (2) + issueKey (~8) + space (1) + status indicator (3) + space (1) = ~15 chars fixed
	const fixedWidth = 15;
	const availableTitleWidth = Math.max(0, width - fixedWidth);

	// Truncate title
	const title = space.linearIssue?.title ?? '';
	const truncatedTitle =
		title.length > availableTitleWidth
			? title.slice(0, availableTitleWidth - 1) + '\u2026'
			: title;

	// Linear state color (applied to issue key)
	// Distinguish between "In Progress" (yellow) and "In Review" (cyan)
	const getStateColor = (): string => {
		const state = space.linearIssue?.state;
		if (!state) return 'gray';
		if (state.type === 'completed') return 'green';
		if (state.type === 'started') {
			// "In Review" gets cyan to distinguish from "In Progress"
			if (state.name === 'In Review') return 'cyan';
			return 'yellow';
		}
		return 'gray';
	};
	const stateColor = getStateColor();

	return (
		<Box>
			{/* Selection indicator */}
			<Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
				{isSelected ? '> ' : '  '}
			</Text>

			{/* Issue key (colored by Linear state) */}
			<Text color={isSelected ? 'cyan' : stateColor} bold>
				{space.name}
			</Text>

			{/* Claude status indicator */}
			<Text> </Text>
			{isWorking ? (
				<ClaudeAnimation color={statusInfo.color} />
			) : (
				<Text color={statusInfo.color}>{statusInfo.icon}</Text>
			)}

			{/* Title (dimmed) */}
			<Text> </Text>
			<Text dimColor wrap="truncate">
				{truncatedTitle}
			</Text>

		</Box>
	);
}
