import React, {useRef, useLayoutEffect} from 'react';
import {Box, Text, measureElement} from 'ink';
import type {UpdateInfo} from '../update-check.ts';

interface Props {
	info: UpdateInfo;
	// Called with the total rendered footprint of the banner (box height +
	// marginBottom) whenever it changes. Used by app.tsx to compensate the
	// mouse hit-test so clicks land on the right workspace row when the
	// content wraps at narrow pane widths.
	onMeasure?: (height: number) => void;
}

// marginBottom on the outer Box. Kept as a named constant because
// measureElement reports the Box's own layout size but not its outer margin,
// so we have to add this back in when reporting the total footprint.
const MARGIN_BOTTOM = 1;

// Prominent banner shown above the workspace list when a newer pappardelle
// version is available on chardigio/pappardelle. Press U to update, X to
// dismiss — both handled by the parent app.tsx key handler.
export default function UpdateBanner({info, onMeasure}: Props) {
	const boxRef = useRef(null);

	useLayoutEffect(() => {
		if (!onMeasure || !boxRef.current) return;
		const {height} = measureElement(boxRef.current);
		onMeasure(height + MARGIN_BOTTOM);
	});

	return (
		<Box
			ref={boxRef}
			borderStyle="round"
			borderColor="magenta"
			paddingX={1}
			marginBottom={MARGIN_BOTTOM}
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
