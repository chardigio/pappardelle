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

	// State badge color
	const stateColor =
		space.linearIssue?.state.type === 'completed'
			? 'green'
			: space.linearIssue?.state.type === 'started'
				? 'yellow'
				: 'gray';

	return (
		<Box>
			{/* Selection indicator */}
			<Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
				{isSelected ? '> ' : '  '}
			</Text>

			{/* Issue key */}
			<Text color={isSelected ? 'cyan' : 'white'} bold>
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

			{/* Fill remaining space */}
			<Box flexGrow={1} />

			{/* State badge (right-aligned) */}
			{space.linearIssue && (
				<Text color={stateColor} dimColor>
					[{space.linearIssue.state.name}]
				</Text>
			)}
		</Box>
	);
}
