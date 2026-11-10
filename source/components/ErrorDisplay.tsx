import {textAttributes, terminalColor, dimText} from '../tui-style.ts';
import {useEffect, useState} from 'react';

import {clipLogEntryForDisplay} from '../clip-error-text.ts';
import {buildLogsHint} from '../error-display-hint.ts';
import {
	subscribeToErrors,
	clearRecentErrors,
	type LogEntry,
} from '../logger.ts';

interface Props {
	maxVisible?: number;
}

export default function ErrorDisplay({maxVisible = 3}: Props) {
	const [errors, setErrors] = useState<LogEntry[]>([]);

	useEffect(() => {
		const unsubscribe = subscribeToErrors(setErrors);
		return unsubscribe;
	}, []);

	if (errors.length === 0) {
		return null;
	}

	// Show only the most recent errors
	const visibleErrors = errors.slice(-maxVisible);
	const hiddenCount = errors.length - visibleErrors.length;

	const clipped = visibleErrors.map(entry => ({
		entry,
		display: clipLogEntryForDisplay({
			message: entry.message,
			error: entry.error,
		}),
	}));
	const anyTruncated = clipped.some(
		c => c.display.headline.truncated || c.display.body?.truncated,
	);
	const showLogsHint = hiddenCount > 0 || anyTruncated;

	return (
		<box
			border
			flexDirection="column"
			borderStyle="single"
			borderColor={terminalColor('red')}
			paddingX={1}
			marginTop={1}
		>
			<box
				flexDirection="row"
				justifyContent="space-between"
				marginBottom={errors.length > 1 ? 1 : 0}
			>
				<text
					flexShrink={1}
					attributes={textAttributes({bold: true})}
					fg={terminalColor('red')}
				>
					Errors ({errors.length})
				</text>
				<text {...dimText()}>Press 'c' to clear</text>
			</box>

			{clipped.map(({entry, display}, i) => (
				<box key={`${entry.timestamp}-${i}`} flexDirection="column">
					<box flexDirection="row">
						<text
							flexShrink={1}
							fg={terminalColor(entry.level === 'error' ? 'red' : 'yellow')}
						>
							[{entry.component}]
						</text>
						<text
							fg={terminalColor()}
							flexShrink={1}
							wrapMode="none"
							height={1}
						>
							{' '}
							{display.headline.text}
						</text>
					</box>
					{display.body && (
						<text {...dimText()} wrapMode="none" height={1}>
							{' '}
							{display.body.text}
						</text>
					)}
				</box>
			))}

			{showLogsHint && (
				<text {...dimText()}>{buildLogsHint(hiddenCount, anyTruncated)}</text>
			)}
		</box>
	);
}

// Export the clear function for use in the app
export {clearRecentErrors};
