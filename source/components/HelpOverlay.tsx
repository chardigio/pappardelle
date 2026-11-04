import {useKeyboard} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor} from '../tui-style.ts';
import {useState} from 'react';

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

	useKeyboard(event => {
		const {input, key} = shortcutKey(event);
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
		<box
			border
			flexDirection="column"
			borderStyle="rounded"
			borderColor={terminalColor('cyan')}
			flexGrow={isFullHeight ? 1 : 0}
			paddingX={2}
			paddingY={1}
		>
			<box marginBottom={1} flexDirection="column">
				<text
					flexShrink={1}
					attributes={textAttributes({bold: true})}
					fg={terminalColor('cyan')}
				>
					Keyboard Shortcuts
				</text>
				<text
					fg={terminalColor()}
					flexShrink={1}
					attributes={textAttributes({dim: true})}
				>
					{formatVersionLine(installedVersion, commitSha, isDevBuild)}
				</text>
			</box>

			<box flexDirection="column" height={viewHeight} overflow="hidden">
				{lines.slice(top, top + viewHeight).map((line, index) => {
					if (line.kind === 'blank')
						return (
							<text fg={terminalColor()} flexShrink={1} key={top + index}>
								{' '}
							</text>
						);
					if (line.kind === 'heading') {
						return (
							<text
								flexShrink={1}
								attributes={textAttributes({bold: true})}
								key={top + index}
								fg={terminalColor('cyan')}
								wrapMode="none"
								height={1}
							>
								{line.text}
							</text>
						);
					}

					return (
						<text
							fg={terminalColor()}
							flexShrink={1}
							key={top + index}
							wrapMode="none"
							height={1}
						>
							<span
								fg={terminalColor(line.row.isCustom ? 'magenta' : 'yellow')}
							>
								{line.row.key.padEnd(rows.maxKeyLength)}
							</span>{' '}
							{line.row.description}
						</text>
					);
				})}
			</box>

			<box flexDirection="row" marginTop={1}>
				<text
					fg={terminalColor()}
					flexShrink={1}
					attributes={textAttributes({dim: true})}
					wrapMode="none"
					height={1}
				>
					{helpFooter(isScrolling)}
				</text>
			</box>
		</box>
	);
}
