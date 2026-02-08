import React from 'react';
import {Box, Text, useInput} from 'ink';

interface Props {
	title: string;
	message: string;
	detail?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export default function ConfirmDialog({
	title,
	message,
	detail,
	onConfirm,
	onCancel,
}: Props) {
	useInput((input, key) => {
		if (key.escape || input === 'n' || input === 'N') {
			onCancel();
		} else if (key.return || input === 'y' || input === 'Y') {
			onConfirm();
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
			<Box marginBottom={1}>
				<Text bold color="red">
					{title}
				</Text>
			</Box>

			<Box marginBottom={1}>
				<Text>{message}</Text>
			</Box>

			{detail && (
				<Box marginBottom={1}>
					<Text dimColor>{detail}</Text>
				</Box>
			)}

			<Box>
				<Text dimColor>
					Press <Text color="green">y</Text> or <Text color="green">Enter</Text>{' '}
					to confirm, <Text color="yellow">n</Text> or{' '}
					<Text color="yellow">Esc</Text> to cancel
				</Text>
			</Box>
		</Box>
	);
}
