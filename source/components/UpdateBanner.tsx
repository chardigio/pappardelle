import React from 'react';
import {Box, Text} from 'ink';
import type {UpdateInfo} from '../update-check.ts';

interface Props {
	info: UpdateInfo;
}

// Prominent banner shown above the workspace list when a newer pappardelle
// version is available on chardigio/pappardelle. Press U to update, X to
// dismiss — both handled by the parent app.tsx key handler.
export default function UpdateBanner({info}: Props) {
	return (
		<Box
			borderStyle="round"
			borderColor="magenta"
			paddingX={1}
			marginBottom={1}
		>
			<Text>
				<Text bold color="magenta">
					Update available:
				</Text>{' '}
				<Text color="yellow">v{info.installedVersion.replace(/^v/, '')}</Text>
				<Text dimColor> → </Text>
				<Text color="green">v{info.latestVersion.replace(/^v/, '')}</Text>
				<Text dimColor> · </Text>
				<Text color="cyan">U</Text>
				<Text dimColor> to update · </Text>
				<Text color="cyan">X</Text>
				<Text dimColor> to dismiss</Text>
			</Text>
		</Box>
	);
}
