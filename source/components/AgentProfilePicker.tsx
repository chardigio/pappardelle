import fs from 'node:fs';
import React, {useState} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import {renderTui} from '../render-tui.ts';
import {createNormalizingStdin} from './kitty-keyboard.ts';
import {
	computePickerWindow,
	handleFilterablePickerKey,
	type FilterablePickerState,
} from '../profile-picker.ts';
import {
	agentPopupVisibleRows,
	agentProfileLabel,
	filterAgentProfiles,
	type AgentProfileRequest,
} from '../agent-profile-popup.ts';

function AgentProfilePicker({
	request,
	onChoose,
}: {
	request: AgentProfileRequest;
	onChoose: (name: string | null) => void;
}) {
	const {exit} = useApp();
	const {stdout} = useStdout();
	const [state, setState] = useState<FilterablePickerState>(() => ({
		query: null,
		index: Math.max(
			0,
			request.options.findIndex(option => option.name === request.selected),
		),
	}));
	const options = filterAgentProfiles(request.options, state.query ?? '');

	useInput((input, key) => {
		const result = handleFilterablePickerKey(state, input, key, options.length);
		setState(result.state);
		if (result.action === 'submit' || result.action === 'select') {
			onChoose(options[result.state.index]?.name ?? null);
			exit();
		} else if (result.action === 'back') {
			onChoose(null);
			exit();
		}
	});

	const {start, end, above, below} = computePickerWindow(
		options.length,
		state.index,
		agentPopupVisibleRows(
			request.options.length,
			stdout?.rows ?? Number.POSITIVE_INFINITY,
		),
	);
	// The default marker sits with the name so a truncated source can't hide it.
	const label = (name: string) =>
		agentProfileLabel(name) +
		(name === request.profileDefault ? ' (default)' : '');
	// Sized from the whole list so the columns don't shift as the filter narrows.
	const nameWidth = Math.max(
		...request.options.map(option => label(option.name).length),
	);

	return (
		<Box flexDirection="column" paddingX={1}>
			{above > 0 && <Text dimColor>↑ {above} more</Text>}
			{options.length === 0 && <Text dimColor>No match</Text>}
			{options.slice(start, end).map((option, offset) => {
				const isSelected = start + offset === state.index;
				return (
					<Box key={option.name}>
						<Box flexShrink={0}>
							<Text color={isSelected ? 'green' : undefined} bold={isSelected}>
								{isSelected ? '❯ ' : '  '}
								{label(option.name).padEnd(nameWidth)}{' '}
							</Text>
						</Box>
						<Text dimColor wrap="truncate-end">
							{option.source}
						</Text>
					</Box>
				);
			})}
			{below > 0 && <Text dimColor>↓ {below} more</Text>}
			<Box marginTop={1}>
				{state.query === null ? (
					<Text dimColor>
						<Text color="green">↑/↓</Text> select · <Text color="cyan">/</Text>{' '}
						filter · <Text color="green">Enter</Text> choose ·{' '}
						<Text color="yellow">Esc</Text> cancel
					</Text>
				) : (
					<Text wrap="truncate-end">
						<Text color="cyan">/{state.query}</Text>
						<Text inverse> </Text>
						<Text dimColor>
							{' '}
							· <Text color="green">Enter</Text> choose ·{' '}
							<Text color="yellow">Esc</Text> clear
						</Text>
					</Text>
				)}
			</Box>
		</Box>
	);
}

/**
 * The `pappardelle pick-agent-profile` entry point that runs inside the popup.
 * A dismissed popup leaves no result file, which the TUI reads as "no change".
 */
export async function runAgentProfilePicker(
	requestPath: string,
	resultPath: string,
): Promise<number> {
	const request = JSON.parse(
		fs.readFileSync(requestPath, 'utf8'),
	) as AgentProfileRequest;
	let chosen: string | null = null;
	const app = renderTui(
		<AgentProfilePicker
			request={request}
			onChoose={name => {
				chosen = name;
			}}
		/>,
		{
			stdin: process.stdin.isTTY
				? createNormalizingStdin(process.stdin)
				: process.stdin,
		},
	);
	await app.waitUntilExit();
	if (chosen !== null) fs.writeFileSync(resultPath, chosen);
	return 0;
}
