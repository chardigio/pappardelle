import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {KeybindingConfig} from '../config.ts';
import {formatVersionLine} from '../help-version-line.ts';
import {
	buildHelpLines,
	buildHelpRows,
	helpFooter,
	HELP_CHROME_ROWS,
} from './help-rows.ts';
import {handleTextViewerKey} from './text-viewer-keys.ts';

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
	/** Rows the overlay may use. The shortcut list scrolls when it needs more. */
	availableHeight?: number;
}

export default function HelpOverlay({
	onClose,
	customKeybindings,
	commitSha,
	installedVersion,
	isDevBuild,
	isFullHeight,
	availableHeight,
}: Props) {
	const [top, setTop] = useState(0);
	const rows = buildHelpRows(customKeybindings);
	const lines = buildHelpLines(rows);
	const viewHeight =
		availableHeight === undefined
			? lines.length
			: Math.max(1, Math.min(lines.length, availableHeight - HELP_CHROME_ROWS));
	const isScrolling = viewHeight < lines.length;

	useInput((input, key) => {
		if (key.escape || input === '?' || key.return) {
			onClose();
			return;
		}

		const result = handleTextViewerKey(input, key, {
			top,
			lineCount: lines.length,
			viewHeight,
		});
		if (result.action === 'scroll') setTop(result.top);
	});

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

			<Box flexDirection="column" height={viewHeight} overflow="hidden">
				{lines.slice(top, top + viewHeight).map((line, index) => {
					if (line.kind === 'blank') return <Text key={top + index}> </Text>;
					if (line.kind === 'heading') {
						return (
							<Text key={top + index} bold color="cyan" wrap="truncate-end">
								{line.text}
							</Text>
						);
					}

					return (
						<Text key={top + index} wrap="truncate-end">
							<Text color={line.row.isCustom ? 'magenta' : 'yellow'}>
								{line.row.key.padEnd(rows.maxKeyLength)}
							</Text>{' '}
							{line.row.description}
						</Text>
					);
				})}
			</Box>

			<Box marginTop={1}>
				<Text dimColor wrap="truncate-end">
					{helpFooter(isScrolling)}
				</Text>
			</Box>
		</Box>
	);
}
