import {execFile} from 'node:child_process';
import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {handleTextViewerKey} from './text-viewer-keys.ts';

type Props = {
	argv: string[];
	title: string;
	height: number;
	onClose: () => void;
};

// Border (2) plus the title row and the hint row.
const CHROME_ROWS = 4;

/** Run a command and show its output in a scrollable, bordered view. */
export default function TextViewer({argv, title, height, onClose}: Props) {
	const [lines, setLines] = useState<string[] | null>(null);
	const [top, setTop] = useState(0);
	const viewHeight = Math.max(1, height - CHROME_ROWS);

	useEffect(() => {
		const [command, ...args] = argv;
		if (!command) {
			setLines(['Nothing to show']);
			return;
		}

		execFile(
			command,
			args,
			{encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
			(error, stdout, stderr) => {
				const output = error ? stderr || error.message : stdout;
				setLines(output.replace(/\n$/, '').split('\n'));
			},
		);
	}, [argv]);

	useInput((input, key) => {
		const result = handleTextViewerKey(input, key, {
			top,
			lineCount: lines?.length ?? 0,
			viewHeight,
		});
		if (result.action === 'close') onClose();
		else setTop(result.top);
	});

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="cyan"
			flexGrow={1}
			paddingX={1}
		>
			<Text bold color="cyan" wrap="truncate-end">
				{title}
			</Text>
			<Box flexDirection="column" height={viewHeight} overflow="hidden">
				{lines === null ? (
					<Text dimColor>Loading…</Text>
				) : (
					lines.slice(top, top + viewHeight).map((line, index) => (
						<Text key={top + index} wrap="truncate-end">
							{line || ' '}
						</Text>
					))
				)}
			</Box>
			<Text dimColor wrap="truncate-end">
				<Text color="cyan">j/k</Text> scroll · <Text color="cyan">space/b</Text>{' '}
				page · <Text color="cyan">g/G</Text> top/bottom ·{' '}
				<Text color="yellow">q/Esc</Text> close
			</Text>
		</Box>
	);
}
