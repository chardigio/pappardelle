import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';

interface Props {
	onSubmit: (prompt: string) => void;
	onCancel: () => void;
}

export default function PromptDialog({onSubmit, onCancel}: Props) {
	const [prompt, setPrompt] = useState('');

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
		}
	});

	const handleSubmit = (value: string) => {
		if (value.trim()) {
			onSubmit(value.trim());
		}
	};

	return (
		<Box
			flexDirection="column"
			borderStyle="double"
			borderColor="green"
			paddingX={2}
			paddingY={1}
			width={65}
		>
			<Box marginBottom={1}>
				<Text bold color="green">
					+ New DOW Session
				</Text>
			</Box>

			<Box marginBottom={1} flexDirection="column">
				<Text dimColor>Enter a prompt or issue key:</Text>
				<Text dimColor>
					- <Text color="cyan">STA-123</Text> = resume existing workspace (if
					PR has commits)
				</Text>
				<Text dimColor>
					- <Text color="cyan">description</Text> = start new workspace with
					Claude
				</Text>
			</Box>

			<Box>
				<Text color="cyan">&gt; </Text>
				<TextInput
					value={prompt}
					onChange={setPrompt}
					onSubmit={handleSubmit}
					placeholder="STA-123 or describe the task..."
				/>
			</Box>

			<Box marginTop={1}>
				<Text dimColor>
					Press <Text color="green">Enter</Text> to start,{' '}
					<Text color="yellow">Esc</Text> to cancel
				</Text>
			</Box>
		</Box>
	);
}
