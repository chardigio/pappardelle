import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {
	subscribeToErrors,
	clearRecentErrors,
	type LogEntry,
} from '../logger.js';

interface Props {
	onClose: () => void;
}

export default function ErrorDialog({onClose}: Props) {
	const [errors, setErrors] = useState<LogEntry[]>([]);

	useEffect(() => {
		const unsubscribe = subscribeToErrors(setErrors);
		return unsubscribe;
	}, []);

	useInput((input, key) => {
		if (key.escape) {
			onClose();
		} else if (input === 'c') {
			clearRecentErrors();
			onClose();
		}
	});

	return (
		<Box
			flexDirection="column"
			borderStyle="double"
			borderColor="red"
			paddingX={2}
			paddingY={1}
		>
			<Box justifyContent="space-between" marginBottom={1}>
				<Text bold color="red">
					Errors ({errors.length})
				</Text>
				<Text dimColor>
					<Text color="yellow">c</Text> clear <Text color="yellow">Esc</Text>{' '}
					close
				</Text>
			</Box>

			{errors.length === 0 ? (
				<Text dimColor>No errors.</Text>
			) : (
				errors.map((entry, i) => (
					<Box
						key={`${entry.timestamp}-${i}`}
						flexDirection="column"
						marginBottom={i < errors.length - 1 ? 1 : 0}
					>
						<Box>
							<Text color={entry.level === 'error' ? 'red' : 'yellow'}>
								[{entry.component}]
							</Text>
							<Text> {entry.message}</Text>
						</Box>
						{entry.error && <Text dimColor> {entry.error}</Text>}
					</Box>
				))
			)}

			{errors.length > 0 && (
				<Box marginTop={1}>
					<Text dimColor>Logs: ~/.pappardelle/logs/</Text>
				</Box>
			)}
		</Box>
	);
}
