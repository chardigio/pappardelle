import {useKeyboard} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor, dimText} from '../tui-style.ts';
import {execFile} from 'node:child_process';
import {useEffect, useMemo, useState} from 'react';

import {handleTextViewerKey} from './text-viewer-keys.ts';
import {toViewerLines} from './text-viewer-lines.ts';

type Props = {
	argv: string[];
	title: string;
	width: number;
	height: number;
	onClose: () => void;
};

// Border (2) plus the title row and the hint row.
const CHROME_ROWS = 4;
// Border (2) plus paddingX={1} on each side.
const CHROME_COLUMNS = 4;

/** Run a command and show its output in a scrollable, bordered view. */
export default function TextViewer({
	argv,
	title,
	width,
	height,
	onClose,
}: Props) {
	const [output, setOutput] = useState<string | null>(null);
	const [top, setTop] = useState(0);
	const viewHeight = Math.max(1, height - CHROME_ROWS);
	const lines = useMemo(
		() =>
			output === null ? null : toViewerLines(output, width - CHROME_COLUMNS),
		[output, width],
	);

	useEffect(() => {
		const [command, ...args] = argv;
		if (!command) {
			setOutput('Nothing to show');
			return;
		}

		execFile(
			command,
			args,
			{encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
			(error, stdout, stderr) => {
				setOutput(error ? stderr || error.message : stdout);
			},
		);
	}, [argv]);

	useKeyboard(event => {
		const {input, key} = shortcutKey(event);
		const result = handleTextViewerKey(input, key, {
			top,
			lineCount: lines?.length ?? 0,
			viewHeight,
		});
		if (result.action === 'close') onClose();
		else setTop(result.top);
	});

	return (
		<box
			border
			flexDirection="column"
			borderStyle="rounded"
			borderColor={terminalColor('cyan')}
			flexGrow={1}
			paddingX={1}
		>
			<text
				flexShrink={1}
				attributes={textAttributes({bold: true})}
				fg={terminalColor('cyan')}
				wrapMode="none"
				height={1}
			>
				{title}
			</text>
			<box flexDirection="column" height={viewHeight} overflow="hidden">
				{lines === null ? (
					<text {...dimText()}>Loading…</text>
				) : (
					lines.slice(top, top + viewHeight).map((line, index) => (
						<text
							fg={terminalColor()}
							flexShrink={1}
							key={top + index}
							wrapMode="none"
							height={1}
						>
							{line || ' '}
						</text>
					))
				)}
			</box>
			<text {...dimText()} wrapMode="none" height={1}>
				<span fg={terminalColor('cyan')}>j/k</span> scroll ·{' '}
				<span fg={terminalColor('cyan')}>space/b</span> page ·{' '}
				<span fg={terminalColor('cyan')}>g/G</span> top/bottom ·{' '}
				<span fg={terminalColor('yellow')}>q/Esc</span> close
			</text>
		</box>
	);
}
