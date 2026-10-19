import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
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
} from '../agent-profile-picker.ts';

type Props = {
	request: AgentProfileRequest;
	availableHeight: number;
	onChoose: (name: string) => void;
	onCancel: () => void;
};

export default function AgentProfilePicker({
	request,
	availableHeight,
	onChoose,
	onCancel,
}: Props) {
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
			const chosen = options[result.state.index];
			if (chosen) onChoose(chosen.name);
			else onCancel();
		} else if (result.action === 'back') {
			onCancel();
		}
	});

	const {start, end, above, below} = computePickerWindow(
		options.length,
		state.index,
		agentPopupVisibleRows(request.options.length, availableHeight),
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
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="cyan"
			flexGrow={1}
			paddingX={1}
		>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Agent profile
				</Text>
			</Box>
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
