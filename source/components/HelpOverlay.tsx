import React from 'react';
import {Box, Text, useInput} from 'ink';
import type {KeybindingConfig} from '../config.ts';
import {formatVersionLine} from '../help-version-line.ts';
import {buildHelpRows} from './help-rows.ts';

interface Props {
	onClose: () => void;
	customKeybindings?: KeybindingConfig[];
	commitSha: string;
	installedVersion?: string | null;
	// When true, the version line is rendered with a `-dev` marker (dev/worktree
	// build running ahead of the latest installed release — STA-1494).
	isDevBuild?: boolean;
	/** Stretch to the parent's height, for a tmux popup sized to fit. */
	isFullHeight?: boolean;
}

export default function HelpOverlay({
	onClose,
	customKeybindings,
	commitSha,
	installedVersion,
	isDevBuild,
	isFullHeight,
}: Props) {
	useInput((_input, key) => {
		if (key.escape || _input === '?' || key.return) {
			onClose();
		}
	});

	const {
		fixed: fixedShortcuts,
		overridable: overridableShortcuts,
		extraCustom,
		maxKeyLength: maxKeyLen,
	} = buildHelpRows(customKeybindings);

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="cyan"
			flexGrow={isFullHeight ? 1 : 0}
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
							<Text> {kb.description}</Text>
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
