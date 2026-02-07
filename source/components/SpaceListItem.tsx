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
	// Format: "STA-123 ✢ title..."
	// issueKey (8 padded) + space (1) + icon (1) + space (1) = 11 chars fixed
	const issueKeyWidth = 8;
	const fixedWidth = issueKeyWidth + 1 + 1 + 1; // 11
	const availableTitleWidth = Math.max(0, width - fixedWidth);

	// Issue key and padding (separate so badge only covers the key text)
	const issueKey = space.name;
	const issueKeyPadding = ' '.repeat(
		Math.max(0, issueKeyWidth - issueKey.length),
	);

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
			{/* Issue key badge (colored by Linear state, inverse gives colored background) */}
			<Text
				color={useBlinkInverse ? textColor : stateColor}
				bold
				inverse={useInverse}
			>
				{issueKey}
			</Text>
			{/* Padding after issue key (regular inverse, no badge color) */}
			<Text inverse={useInverse} color={textColor}>
				{issueKeyPadding}
			</Text>

			{/* Claude status indicator (regular inverse when selected, no badge) */}
			<Text inverse={useInverse} color={textColor}>
				{' '}
			</Text>
			{isWorking ? (
				<ClaudeAnimation
					color={
						useBlinkInverse
							? textColor
							: useSelectionInverse
								? undefined
								: statusInfo.color
					}
					inverse={useInverse}
				/>
			) : (
				<Text
					color={
						useBlinkInverse
							? textColor
							: useSelectionInverse
								? undefined
								: statusInfo.color
					}
					inverse={useInverse}
				>
					{statusInfo.icon ?? '?'}
				</Text>
			)}

			{/* Title (dimmed when not highlighted) */}
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
