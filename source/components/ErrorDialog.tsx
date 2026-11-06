import {useKeyboard} from '@opentui/react';
import {Fragment} from 'react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor} from '../tui-style.ts';

import type {LogEntry} from '../logger.ts';
import Gap from './Gap.tsx';

interface Props {
	errors: LogEntry[];
	onClose: () => void;
	onClear: () => void;
	/** Stretch to the parent's height, for a tmux popup sized to fit. */
	isFullHeight?: boolean;
}

export default function ErrorDialog({
	errors,
	onClose,
	onClear,
	isFullHeight,
}: Props) {
	useKeyboard(event => {
		const {input, key} = shortcutKey(event);
		if (key.escape) {
			onClose();
		} else if (input === 'c') {
			onClear();
		}
	});

	return (
		<box
			border
			flexDirection="column"
			borderStyle="double"
			borderColor={terminalColor('red')}
			flexGrow={isFullHeight ? 1 : 0}
			overflow="hidden"
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" justifyContent="space-between" flexShrink={0}>
				<text
					flexShrink={1}
					attributes={textAttributes({bold: true})}
					fg={terminalColor('red')}
				>
					Errors ({errors.length})
				</text>
				<text
					fg={terminalColor()}
					flexShrink={1}
					attributes={textAttributes({dim: true})}
				>
					<span fg={terminalColor('yellow')}>c</span> clear{' '}
					<span fg={terminalColor('yellow')}>Esc</span> close
				</text>
			</box>
			<Gap />

			{errors.length === 0 ? (
				<text
					fg={terminalColor()}
					flexShrink={0}
					attributes={textAttributes({dim: true})}
				>
					No errors.
				</text>
			) : (
				errors.map((entry, i) => (
					<Fragment key={`${entry.timestamp}-${i}`}>
						{i > 0 && <Gap />}
						<box flexDirection="column" flexShrink={0}>
							<box flexDirection="row">
								<text
									flexShrink={1}
									fg={terminalColor(entry.level === 'error' ? 'red' : 'yellow')}
								>
									[{entry.component}]
								</text>
								<text fg={terminalColor()} flexShrink={1}>
									{' '}
									{entry.message}
								</text>
							</box>
							{entry.error && (
								<text
									fg={terminalColor()}
									flexShrink={1}
									attributes={textAttributes({dim: true})}
								>
									{' '}
									{entry.error}
								</text>
							)}
						</box>
					</Fragment>
				))
			)}

			{errors.length > 0 && <Gap />}
			{errors.length > 0 && (
				<box flexDirection="row" flexShrink={0}>
					<text
						fg={terminalColor()}
						flexShrink={1}
						attributes={textAttributes({dim: true})}
					>
						Logs: ~/.pappardelle/logs/
					</text>
				</box>
			)}
		</box>
	);
}
