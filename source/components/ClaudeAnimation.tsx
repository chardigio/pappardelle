import React, {useState, useEffect} from 'react';
import {Text} from 'ink';

// Claude Code's exact spinner animation frames
// These are the characters used by Claude Code during "Working"/"Simmering" state
// Reverse engineered from Claude Code CLI output
const CLAUDE_FRAMES = ['✢', '·', '✢', '✶', '✻', '✽'];

interface Props {
	color?: string;
}

export default function ClaudeAnimation({color = 'blue'}: Props) {
	const [frameIndex, setFrameIndex] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			setFrameIndex((prev) => (prev + 1) % CLAUDE_FRAMES.length);
		}, 100); // ~100ms per frame to match Claude Code's animation speed

		return () => clearInterval(interval);
	}, []);

	return <Text color={color}>{CLAUDE_FRAMES[frameIndex]}</Text>;
}
