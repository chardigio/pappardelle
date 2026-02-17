import React, {useState, useMemo} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import {
	loadConfig,
	matchProfiles,
	getDefaultProfile,
	type PappardelleConfig,
} from '../config.ts';

// Issue key patterns
const ISSUE_KEY_PATTERN = /^[A-Z]+-\d+$/;
const ISSUE_NUMBER_PATTERN = /^(\d+)$/;
const LINEAR_URL_PATTERN = /^https:\/\/linear\.app\/.+\/issue\/([A-Z]+-\d+)/;

interface Props {
	onSubmit: (prompt: string) => void;
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

	// Determine what profile will be selected based on current input
	const profileInfo = useMemo(() => {
		if (!config) return null;

		const trimmed = prompt.trim();
		if (!trimmed) return null;

		// Check if input is an issue key or URL (uses default profile)
		if (
			ISSUE_KEY_PATTERN.test(trimmed) ||
			ISSUE_NUMBER_PATTERN.test(trimmed) ||
			LINEAR_URL_PATTERN.test(trimmed)
		) {
			const defaultProfile = getDefaultProfile(config);
			return {
				name: defaultProfile.name,
				displayName: defaultProfile.profile.display_name,
				hasIos: !!defaultProfile.profile.ios,
				isDefault: true,
				matchedKeywords: [] as string[],
			};
		}

		// It's a description - match by keywords
		const matches = matchProfiles(config, trimmed);
		if (matches.length > 0) {
			const best = matches[0]!;
			return {
				name: best.name,
				displayName: best.profile.display_name,
				hasIos: !!best.profile.ios,
				isDefault: false,
				matchedKeywords: best.matchedKeywords,
			};
		}

		// No matches - use default
		const defaultProfile = getDefaultProfile(config);
		return {
			name: defaultProfile.name,
			displayName: defaultProfile.profile.display_name,
			hasIos: !!defaultProfile.profile.ios,
			isDefault: true,
			matchedKeywords: [] as string[],
		};
	}, [config, prompt]);

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
		>
			<Box marginBottom={1}>
				<Text bold color="green">
					+ New DOW Session
				</Text>
			</Box>

			<Box marginBottom={1} flexDirection="column">
				<Text dimColor>Enter a prompt or issue key:</Text>
				<Text dimColor>
					- <Text color="cyan">STA-123</Text> or <Text color="cyan">123</Text> =
					resume existing workspace (if PR has commits)
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
					<Text color={profileInfo.hasIos ? 'magenta' : 'blue'}>
						{profileInfo.displayName}
					</Text>
					{profileInfo.hasIos && <Text dimColor> (iOS)</Text>}
					{profileInfo.matchedKeywords.length > 0 && (
						<Text dimColor> ← {profileInfo.matchedKeywords.join(', ')}</Text>
					)}
					{profileInfo.isDefault &&
						profileInfo.matchedKeywords.length === 0 && (
							<Text dimColor> (default)</Text>
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
