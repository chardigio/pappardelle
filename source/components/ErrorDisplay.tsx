import React, {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import {
	subscribeToErrors,
	clearRecentErrors,
	type LogEntry,
} from '../logger.js';

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

			{visibleErrors.map((entry, i) => (
				<Box key={`${entry.timestamp}-${i}`} flexDirection="column">
					<Box>
						<Text color={entry.level === 'error' ? 'red' : 'yellow'}>
							[{entry.component}]
						</Text>
						<Text> {entry.message}</Text>
					</Box>
					{entry.error && <Text dimColor> {entry.error}</Text>}
				</Box>
			))}

			{hiddenCount > 0 && (
				<Text dimColor>
					...and {hiddenCount} more (see ~/.pappardelle/logs/)
				</Text>
			)}
		</Box>
	);
}

// Export the clear function for use in the app
export {clearRecentErrors};
