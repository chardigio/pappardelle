import React, {useState, useEffect} from 'react';
import {Text} from 'ink';
import {COLORS} from '../types.js';

// Claude Code spinner animation frames
// Source: https://github.com/farouqaldori/claude-island/blob/main/ClaudeIsland/UI/Components/ProcessingSpinner.swift
const CLAUDE_FRAMES = ['·', '✢', '✳', '∗', '✻', '✽'];

interface Props {
	color?: string;
}

export default function ClaudeAnimation({color = COLORS.CLAUDE_ORANGE}: Props) {
	const [frameIndex, setFrameIndex] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			setFrameIndex(prev => (prev + 1) % CLAUDE_FRAMES.length);
		}, 150); // 150ms per frame (matches claude-island)

		return () => clearInterval(interval);
	}, []);

	return <Text color={color}>{CLAUDE_FRAMES[frameIndex]}</Text>;
}
