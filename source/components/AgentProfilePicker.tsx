import {useKeyboard} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor} from '../tui-style.ts';
import {useRef, useState} from 'react';

import {
	computePickerWindow,
	handleFilterablePickerKey,
	type FilterablePickerState,
} from '../profile-picker.ts';
import {
	cutAgentProfileName,
	agentPopupList,
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
	// Ink hands every key of a burst to the handler before React re-renders,
	// so keys read the latest state here.
	const stateRef = useRef(state);

	useKeyboard(event => {
		const {input, key} = shortcutKey(event);
		const shown = filterAgentProfiles(
			request.options,
			stateRef.current.query ?? '',
		);
		const result = handleFilterablePickerKey(
			stateRef.current,
			input,
			key,
			shown.length,
		);
		stateRef.current = result.state;
		setState(result.state);
		if (result.action === 'submit' || result.action === 'select') {
			const chosen = shown[result.state.index];
			if (chosen) onChoose(chosen.name);
			else onCancel();
		} else if (result.action === 'back') {
			onCancel();
		}
	});

	const list = agentPopupList(request.options.length, availableHeight);
	const {start, end, above, below} = computePickerWindow(
		options.length,
		state.index,
		list.rows,
	);
	// The default marker sits with the name so a truncated source can't hide it.
	const label = (name: string) =>
		cutAgentProfileName(agentProfileLabel(name)) +
		(name === request.profileDefault ? ' (default)' : '');
	// Sized from the whole list so the columns don't shift as the filter narrows.
	const nameWidth = Math.max(
		...request.options.map(option => label(option.name).length),
	);

	return (
		<box
			border
			flexDirection="column"
			borderStyle="rounded"
			borderColor={terminalColor('cyan')}
			flexGrow={1}
			paddingX={1}
		>
			<box flexDirection="row" marginBottom={1}>
				<text
					flexShrink={1}
					attributes={textAttributes({bold: true})}
					fg={terminalColor('cyan')}
				>
					Agent profile
				</text>
			</box>
			{list.scrollMarkers && above > 0 && (
				<text
					fg={terminalColor()}
					flexShrink={1}
					attributes={textAttributes({dim: true})}
				>
					↑ {above} more
				</text>
			)}
			{options.length === 0 && (
				<text
					fg={terminalColor()}
					flexShrink={1}
					attributes={textAttributes({dim: true})}
				>
					No match
				</text>
			)}
			{options.slice(start, end).map((option, offset) => {
				const isSelected = start + offset === state.index;
				return (
					<box flexDirection="row" key={option.name}>
						<box flexDirection="row" flexShrink={0}>
							<text
								flexShrink={1}
								attributes={textAttributes({bold: isSelected})}
								fg={terminalColor(isSelected ? 'green' : undefined)}
							>
								{isSelected ? '❯ ' : '  '}
								{label(option.name).padEnd(nameWidth)}{' '}
							</text>
						</box>
						<text
							fg={terminalColor()}
							flexShrink={1}
							attributes={textAttributes({dim: true})}
							wrapMode="none"
							height={1}
						>
							{option.source}
						</text>
					</box>
				);
			})}
			{list.scrollMarkers && below > 0 && (
				<text
					fg={terminalColor()}
					flexShrink={1}
					attributes={textAttributes({dim: true})}
				>
					↓ {below} more
				</text>
			)}
			<box flexDirection="row" marginTop={1}>
				{state.query === null ? (
					<text
						fg={terminalColor()}
						flexShrink={1}
						attributes={textAttributes({dim: true})}
						wrapMode="none"
						height={1}
					>
						<span fg={terminalColor('green')}>↑/↓</span> select ·{' '}
						<span fg={terminalColor('cyan')}>/</span> filter ·{' '}
						<span fg={terminalColor('green')}>Enter</span> choose ·{' '}
						<span fg={terminalColor('yellow')}>Esc</span> cancel
					</text>
				) : (
					<text fg={terminalColor()} flexShrink={1} wrapMode="none" height={1}>
						<span fg={terminalColor('cyan')}>/{state.query}</span>
						<span attributes={textAttributes({inverse: true})}> </span>
						<span attributes={textAttributes({dim: true})}>
							{' '}
							· <span fg={terminalColor('green')}>Enter</span> choose ·{' '}
							<span fg={terminalColor('yellow')}>Esc</span> clear
						</span>
					</text>
				)}
			</box>
		</box>
	);
}
