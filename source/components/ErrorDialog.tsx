import {useKeyboard} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor} from '../tui-style.ts';

import type {LogEntry} from '../logger.ts';

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
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" justifyContent="space-between" marginBottom={1}>
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

			{errors.length === 0 ? (
				<text
					fg={terminalColor()}
					flexShrink={1}
					attributes={textAttributes({dim: true})}
				>
					No errors.
				</text>
			) : (
				errors.map((entry, i) => (
					<box
						key={`${entry.timestamp}-${i}`}
						flexDirection="column"
						marginBottom={i < errors.length - 1 ? 1 : 0}
					>
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
				))
			)}

			{errors.length > 0 && (
				<box flexDirection="row" marginTop={1}>
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
