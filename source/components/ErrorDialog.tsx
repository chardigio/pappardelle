import React from 'react';
import {Box, Text, useInput} from 'ink';
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
	useInput((input, key) => {
		if (key.escape) {
			onClose();
		} else if (input === 'c') {
			onClear();
		}
	});

	return (
		<Box
			flexDirection="column"
			borderStyle="double"
			borderColor="red"
			flexGrow={isFullHeight ? 1 : 0}
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
