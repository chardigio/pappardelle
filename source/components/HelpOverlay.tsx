import {useKeyboard} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor, dimText} from '../tui-style.ts';
import {useRef, useState} from 'react';

import type {KeybindingConfig} from '../config.ts';
import {formatVersionLine} from '../help-version-line.ts';
import {
	buildHelpLines,
	buildHelpRows,
	helpFooter,
	HELP_CHROME_ROWS,
} from './help-rows.ts';
import {handleTextViewerKey} from './text-viewer-keys.ts';
import TruncatedLine from './TruncatedLine.tsx';

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
	/** Adds the group collapse keys of the grouped rail. */
	isRailGrouped?: boolean;
}

export default function HelpOverlay({
	onClose,
	customKeybindings,
	commitSha,
	installedVersion,
	isDevBuild,
	isFullHeight,
	availableHeight,
	isRailGrouped,
}: Props) {
	const [top, setTop] = useState(0);
	// Several keys can arrive before the next render.
	const topNow = useRef(0);
	const rows = buildHelpRows(customKeybindings, isRailGrouped);
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
			top: topNow.current,
			lineCount: lines.length,
			viewHeight,
		});
		if (result.action !== 'scroll') return;
		topNow.current = result.top;
		setTop(result.top);
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
				<text {...dimText()}>
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
							<TruncatedLine
								key={top + index}
								runs={[
									{
										text: line.text,
										fg: terminalColor('cyan'),
										attributes: textAttributes({bold: true}),
									},
								]}
							/>
						);
					}

					return (
						<TruncatedLine
							key={top + index}
							runs={[
								{
									text: line.row.key.padEnd(rows.maxKeyLength) + ' ',
									fg: terminalColor(line.row.isCustom ? 'magenta' : 'yellow'),
								},
								{text: line.row.description},
							]}
						/>
					);
				})}
			</box>

			<box flexDirection="row" marginTop={1}>
				<TruncatedLine
					runs={[
						{
							text: helpFooter(isScrolling),
							attributes: textAttributes({dim: true}),
						},
					]}
				/>
			</box>
		</box>
	);
}
