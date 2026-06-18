import React from 'react';
import {Box, Text, useInput} from 'ink';
import type {KeybindingConfig} from '../config.ts';
import {formatVersionLine} from '../help-version-line.ts';

interface Props {
	onClose: () => void;
	customKeybindings?: KeybindingConfig[];
	commitSha: string;
	installedVersion?: string | null;
	// When true, the version line is rendered with a `-dev` marker (dev/worktree
	// build running ahead of the latest installed release — STA-1494).
	isDevBuild?: boolean;
}

/** Default descriptions for overridable keys. */
const defaultKeyDescriptions: Record<string, string> = {
	g: 'Open PR / MR in browser',
	i: 'Open issue in browser',
	d: 'Open IDE (Cursor)',
	o: 'Open workspace (apps, links, etc.)',
	p: 'Git pull',
	e: 'Show errors',
};

const fixedShortcuts = [
	{key: 'j / ↓', description: 'Move down'},
	{key: 'k / ↑', description: 'Move up'},
	{key: 'Enter', description: 'Focus Claude pane'},
	{key: 'n', description: 'New space'},
	{key: 'Del', description: 'Close space'},
	{key: '/', description: 'Search spaces'},
	{key: 'q', description: 'Quit'},
	{key: '?', description: 'Show this help'},
];

export default function HelpOverlay({
	onClose,
	customKeybindings,
	commitSha,
	installedVersion,
	isDevBuild,
}: Props) {
	useInput((_input, key) => {
		if (key.escape || _input === '?' || key.return) {
			onClose();
		}
	});

	// Build a map of custom keybindings by key for quick lookup
	const customByKey = new Map(
		(customKeybindings ?? []).map(kb => [kb.key, kb]),
	);

	// Build the overridable defaults section — show custom description if overridden,
	// hide if disabled, show default otherwise
	const overridableShortcuts: Array<{
		key: string;
		description: string;
		isCustom: boolean;
	}> = [];
	for (const [key, defaultDesc] of Object.entries(defaultKeyDescriptions)) {
		const custom = customByKey.get(key);
		if (custom?.disabled) continue; // Disabled — omit entirely
		if (custom) {
			overridableShortcuts.push({
				key,
				description: custom.name + (custom.send_to_claude ? ' → Claude' : ''),
				isCustom: true,
			});
		} else {
			overridableShortcuts.push({
				key,
				description: defaultDesc,
				isCustom: false,
			});
		}
	}

	// Custom keybindings that are NOT overriding a default key
	const extraCustom = (customKeybindings ?? []).filter(
		kb => !kb.disabled && !(kb.key in defaultKeyDescriptions),
	);

	// Combine all for alignment
	const allShortcuts = [
		...fixedShortcuts,
		...overridableShortcuts,
		...extraCustom.map(kb => ({
			key: kb.key,
			description: kb.name + (kb.send_to_claude ? ' → Claude' : ''),
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
				<Text dimColor>
					{formatVersionLine(installedVersion, commitSha, isDevBuild)}
				</Text>
			</Box>

			{fixedShortcuts.map(s => (
				<Box key={s.key}>
					<Text color="yellow">{s.key.padEnd(maxKeyLen)}</Text>
					<Text> {s.description}</Text>
				</Box>
			))}

			{overridableShortcuts.length > 0 && (
				<>
					{overridableShortcuts.map(s => (
						<Box key={s.key}>
							<Text color={s.isCustom ? 'magenta' : 'yellow'}>
								{s.key.padEnd(maxKeyLen)}
							</Text>
							<Text> {s.description}</Text>
						</Box>
					))}
				</>
			)}

			{extraCustom.length > 0 && (
				<>
					<Box marginTop={1} marginBottom={1}>
						<Text bold color="cyan">
							Custom Commands
						</Text>
					</Box>
					{extraCustom.map(kb => (
						<Box key={kb.key}>
							<Text color="magenta">{kb.key.padEnd(maxKeyLen)}</Text>
							<Text>
								{' '}
								{kb.name}
								{kb.send_to_claude ? ' → Claude' : ''}
							</Text>
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
