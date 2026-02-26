import React from 'react';
import {Box, Text, useInput} from 'ink';
import type {KeybindingConfig} from '../config.ts';

interface Props {
	onClose: () => void;
	customKeybindings?: KeybindingConfig[];
	commitSha: string;
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

export default function HelpOverlay({
	onClose,
	customKeybindings,
	commitSha,
}: Props) {
	useInput((_input, key) => {
		if (key.escape || _input === '?' || key.return) {
			onClose();
		}
	});

	// Combine built-in and custom shortcuts for alignment
	const allShortcuts = [
		...shortcuts,
		...(customKeybindings ?? []).map(kb => ({
			key: kb.key,
			description: kb.name,
		})),
	];
	const maxKeyLen = Math.max(...allShortcuts.map(s => s.key.length));

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="cyan"
			paddingX={2}
			paddingY={1}
		>
			<Box marginBottom={1} flexDirection="column">
				<Text bold color="cyan">
					Keyboard Shortcuts
				</Text>
				<Text dimColor>pappardelle ({commitSha})</Text>
			</Box>

			{shortcuts.map(s => (
				<Box key={s.key}>
					<Text color="yellow">{s.key.padEnd(maxKeyLen)}</Text>
					<Text> {s.description}</Text>
				</Box>
			))}

			{customKeybindings && customKeybindings.length > 0 && (
				<>
					<Box marginTop={1} marginBottom={1}>
						<Text bold color="cyan">
							Custom Commands
						</Text>
					</Box>
					{customKeybindings.map(kb => (
						<Box key={kb.key}>
							<Text color="magenta">{kb.key.padEnd(maxKeyLen)}</Text>
							<Text> {kb.name}</Text>
						</Box>
					))}
				</>
			)}

			<Box marginTop={1}>
				<Text dimColor>Press Esc, Enter, or ? to close</Text>
			</Box>
		</Box>
	);
}
