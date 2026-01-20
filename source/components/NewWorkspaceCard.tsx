import React from 'react';
import {Box, Text} from 'ink';

interface Props {
	isSelected: boolean;
	width: number;
	height: number;
}

export default function NewWorkspaceCard({isSelected, width, height}: Props) {
	const borderColor = isSelected ? 'green' : 'gray';

	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			borderStyle={isSelected ? 'double' : 'round'}
			borderColor={borderColor}
			alignItems="center"
			justifyContent="center"
		>
			<Text bold color={isSelected ? 'green' : 'gray'} dimColor={!isSelected}>
				+
			</Text>
			<Text dimColor={!isSelected} color={isSelected ? 'green' : 'gray'}>
				New Session
			</Text>
		</Box>
	);
}
