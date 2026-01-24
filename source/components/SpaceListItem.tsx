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
	// Format: "> STA-123  ✢ Working  title..."
	// selector (2) + issueKey (8 padded) + space (2) + icon (1) + space (1) + label (10 padded) + space (2) = 26 chars fixed
	const issueKeyWidth = 8;
	const statusLabelWidth = 10;
	const fixedWidth = 2 + issueKeyWidth + 2 + 1 + 1 + statusLabelWidth + 2; // 26
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

	return (
		<Box>
			{/* Selection indicator */}
			<Text color={isSelected ? 'white' : undefined} bold={isSelected}>
				{isSelected ? '> ' : '  '}
			</Text>

			{/* Issue key (colored by Linear state, padded for alignment) */}
			<Text color={isSelected ? 'white' : stateColor} bold>
				{paddedIssueKey}
			</Text>

			{/* Claude status indicator + label */}
			<Text>  </Text>
			{isWorking ? (
				<ClaudeAnimation color={statusInfo.color} />
			) : (
				<Text color={statusInfo.color}>{statusInfo.icon}</Text>
			)}
			<Text> </Text>
			<Text color={statusInfo.color}>
				{statusInfo.label.padEnd(statusLabelWidth)}
			</Text>

			{/* Title (dimmed) */}
			<Text>  </Text>
			<Text dimColor wrap="truncate">
				{truncatedTitle}
			</Text>

		</Box>
	);
}
