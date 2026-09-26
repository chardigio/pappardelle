import React from 'react';
import {Text} from 'ink';
import {COLORS} from '../types.ts';
import {useSpinnerFrame} from '../animation-clock.ts';

// Claude Code spinner animation frames
// Source: https://github.com/farouqaldori/claude-island/blob/main/ClaudeIsland/UI/Components/ProcessingSpinner.swift
const CLAUDE_FRAMES = ['·', '✢', '✳', '∗', '✻', '✽'];

interface Props {
	color?: string;
	// eslint-disable-next-line react/boolean-prop-naming
	inverse?: boolean;
}

export default function ClaudeAnimation({
	color = COLORS.CLAUDE_ORANGE,
	inverse = false,
}: Props) {
	const frameIndex = useSpinnerFrame() % CLAUDE_FRAMES.length;

	return (
		<Text color={color} inverse={inverse}>
			{CLAUDE_FRAMES[frameIndex]}
		</Text>
	);
}
