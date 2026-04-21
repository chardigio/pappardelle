import React, {useState, useMemo} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import {
	loadConfig,
	determineProfileForInput,
	type PappardelleConfig,
} from '../config.ts';

interface Props {
	onSubmit: (prompt: string, profileName: string | null) => void;
	onCancel: () => void;
}

export default function PromptDialog({onSubmit, onCancel}: Props) {
	const [prompt, setPrompt] = useState('');

	// Load config once
	const config = useMemo((): PappardelleConfig | null => {
		try {
			return loadConfig();
		} catch {
			return null;
		}
	}, []);

	// Determine what profile will be selected based on current input.
	// This must stay in lockstep with what we pass to idow — both the display
	// and the spawned command go through determineProfileForInput.
	const profileInfo = useMemo(() => {
		if (!config) return null;
		return determineProfileForInput(config, prompt);
	}, [config, prompt]);

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
		}
	});

	const handleSubmit = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		// Recompute against the submitted value rather than trusting stale state —
		// profileInfo is derived from `prompt`, which is the same thing, but being
		// explicit keeps the invariant local to this handler.
		// Deferred selections must forward null so idow's tracker_projects lookup runs
		// instead of being short-circuited by a forced --profile flag.
		const chosen = config ? determineProfileForInput(config, trimmed) : null;
		const forwardedName = chosen?.kind === 'resolved' ? chosen.name : null;
		onSubmit(trimmed, forwardedName);
	};

	return (
		<Box
			flexDirection="column"
			borderStyle="double"
			borderColor="green"
			paddingX={2}
			paddingY={1}
		>
			<Box marginBottom={1}>
				<Text bold color="green">
					+ New Session
				</Text>
			</Box>

			<Box marginBottom={1} flexDirection="column">
				<Text dimColor>Enter a prompt or issue key:</Text>
				<Text dimColor>
					- <Text color="cyan">STA-123</Text> or <Text color="cyan">123</Text> =
					open workspace for existing issue
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
					placeholder="STA-123, 123, or describe the task..."
				/>
			</Box>

			{profileInfo && (
				<Box marginTop={1}>
					<Text dimColor>Profile: </Text>
					{profileInfo.kind === 'deferred' ? (
						<Text dimColor italic>
							{profileInfo.displayName}
						</Text>
					) : (
						<>
							<Text color="blue">{profileInfo.displayName}</Text>
							{profileInfo.matchedKeywords.length > 0 && (
								<Text dimColor>
									{' '}
									← {profileInfo.matchedKeywords.join(', ')}
								</Text>
							)}
							{profileInfo.enforced && <Text color="magenta"> (enforced)</Text>}
							{profileInfo.isDefault &&
								profileInfo.matchedKeywords.length === 0 && (
									<Text dimColor> (default)</Text>
								)}
						</>
					)}
				</Box>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					Press <Text color="green">Enter</Text> to start,{' '}
					<Text color="yellow">Esc</Text> to cancel
				</Text>
			</Box>
		</Box>
	);
}
