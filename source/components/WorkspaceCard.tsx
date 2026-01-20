import React from 'react';
import {Box, Text} from 'ink';
import type {WorkspaceData} from '../types.js';
import {getAppIcon, CLAUDE_STATUS_DISPLAY} from '../types.js';

interface Props {
	workspace: WorkspaceData;
	isSelected: boolean;
	width: number;
	height: number;
}

export default function WorkspaceCard({
	workspace,
	isSelected,
	width,
	height,
}: Props) {
	// Determine border color: green if focused, cyan if selected, gray otherwise
	const borderColor = workspace.isVisible
		? 'green'
		: isSelected
			? 'cyan'
			: 'gray';

	// Border style: double if focused or selected
	const borderStyle =
		workspace.isVisible || isSelected ? 'double' : 'round';

	const statusInfo = workspace.claudeStatus
		? CLAUDE_STATUS_DISPLAY[workspace.claudeStatus]
		: CLAUDE_STATUS_DISPLAY.unknown;

	// Calculate available content width (width - 2 for borders - 2 for paddingX)
	const contentWidth = width - 4;

	// Get unique app icons (max 5, each is 2 chars + space separator)
	const uniqueApps = [...new Set(workspace.windows.map((w) => w['app-name']))];
	const appIcons = uniqueApps.slice(0, 5).map((app) => getAppIcon(app));

	// Truncate title to fit
	const maxTitleLength = contentWidth;
	const title = workspace.linearIssue?.title ?? workspace.name;
	const truncatedTitle =
		title.length > maxTitleLength
			? title.slice(0, maxTitleLength - 1) + '…'
			: title;

	// Header color based on state
	const headerColor = workspace.isVisible
		? 'green'
		: isSelected
			? 'cyan'
			: 'white';

	// Build footer with exact padding (all ASCII, so string.length = display width)
	const iconStr = appIcons.length > 0 ? appIcons.join(' ') : '';
	const statusStr = `${statusInfo.icon} ${statusInfo.label}`;
	const paddingNeeded = contentWidth - iconStr.length - statusStr.length;
	const padding = paddingNeeded > 0 ? ' '.repeat(paddingNeeded) : ' ';
	const footerStr = iconStr + padding + statusStr;

	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			borderStyle={borderStyle}
			borderColor={borderColor}
			paddingX={1}
		>
			{/* Header: Issue key + active indicator */}
			<Box>
				{workspace.isVisible && (
					<Text color="green" bold>{'● '}</Text>
				)}
				<Text bold color={headerColor}>
					{workspace.name}
				</Text>
				<Box flexGrow={1} />
				{workspace.linearIssue && (
					<Text dimColor>{workspace.linearIssue.state.name}</Text>
				)}
			</Box>

			{/* Title (if Linear issue) */}
			{workspace.linearIssue && (
				<Text wrap="truncate" dimColor>
					{truncatedTitle}
				</Text>
			)}

			{/* Spacer */}
			<Box flexGrow={1} />

			{/* Footer: Apps and Claude status */}
			<Text>{footerStr}</Text>
		</Box>
	);
}
