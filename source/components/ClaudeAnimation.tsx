import {terminalColor} from '../tui-style.ts';
import type {SpanPaint} from './row-highlight.ts';

import {COLORS} from '../types.ts';
import {useSpinnerFrame} from '../animation-clock.ts';

// Claude Code spinner animation frames
// Source: https://github.com/farouqaldori/claude-island/blob/main/ClaudeIsland/UI/Components/ProcessingSpinner.swift
const CLAUDE_FRAMES = ['·', '✢', '✳', '∗', '✻', '✽'];

const defaultPaint: SpanPaint = {
	fg: terminalColor(COLORS.CLAUDE_ORANGE),
	bg: undefined,
	attributes: 0,
};

export default function ClaudeAnimation({
	paint = defaultPaint,
}: {
	paint?: SpanPaint;
}) {
	const frameIndex = useSpinnerFrame() % CLAUDE_FRAMES.length;

	return (
		<text flexShrink={1} {...paint}>
			{CLAUDE_FRAMES[frameIndex]}
		</text>
	);
}
