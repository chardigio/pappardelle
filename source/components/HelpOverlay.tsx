import React from 'react';
import {Box, Text, useInput} from 'ink';

interface Props {
	onClose: () => void;
}

const shortcuts = [
	{key: 'j / ↓', description: 'Move down'},
	{key: 'k / ↑', description: 'Move up'},
	{key: 'Enter', description: 'Focus Claude pane'},
	{key: 'g', description: 'Open PR / MR in browser'},
	{key: 'i', description: 'Open issue in browser'},
	{key: 'd', description: 'Open IDE (Cursor)'},
	{key: 'n', description: 'New space'},
	{key: 'o', description: 'Open workspace (apps, links, etc.)'},
	{key: 'Del', description: 'Close space'},
	{key: 'r', description: 'Refresh list'},
	{key: 'e', description: 'Show errors'},
	{key: '?', description: 'Show this help'},
];

export default function HelpOverlay({onClose}: Props) {
	useInput((_input, key) => {
		if (key.escape || _input === '?' || key.return) {
			onClose();
		}
	});

	// Find the longest key string for alignment
	const maxKeyLen = Math.max(...shortcuts.map(s => s.key.length));

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="cyan"
			paddingX={2}
			paddingY={1}
		>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Keyboard Shortcuts
				</Text>
			</Box>

			{shortcuts.map(s => (
				<Box key={s.key}>
					<Text color="yellow">{s.key.padEnd(maxKeyLen)}</Text>
					<Text> {s.description}</Text>
				</Box>
			))}

			<Box marginTop={1}>
				<Text dimColor>Press Esc, Enter, or ? to close</Text>
			</Box>
		</Box>
	);
}
