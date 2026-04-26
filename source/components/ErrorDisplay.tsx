import React, {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import {clipErrorText} from '../clip-error-text.ts';
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

	const clipped = visibleErrors.map(entry =>
		entry.error
			? {entry, body: clipErrorText(entry.error)}
			: {entry, body: null},
	);
	const anyTruncated = clipped.some(c => c.body?.truncated);
	const showLogsHint = hiddenCount > 0 || anyTruncated;

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor="red"
			paddingX={1}
			marginTop={1}
		>
			<Box
				justifyContent="space-between"
				marginBottom={errors.length > 1 ? 1 : 0}
			>
				<Text bold color="red">
					Errors ({errors.length})
				</Text>
				<Text dimColor>Press 'c' to clear</Text>
			</Box>

			{clipped.map(({entry, body}, i) => (
				<Box key={`${entry.timestamp}-${i}`} flexDirection="column">
					<Box>
						<Text color={entry.level === 'error' ? 'red' : 'yellow'}>
							[{entry.component}]
						</Text>
						<Text> {entry.message}</Text>
					</Box>
					{body && <Text dimColor> {body.text}</Text>}
				</Box>
			))}

			{showLogsHint && (
				<Text dimColor>{buildLogsHint(hiddenCount, anyTruncated)}</Text>
			)}
		</Box>
	);
}

// Export the clear function for use in the app
export {clearRecentErrors};
