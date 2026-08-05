import React, {useState, useMemo} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import TextInput from './TextInput.tsx';
import TitledBox from './TitledBox.tsx';
import {dialogWidth} from './dialog-width.ts';
import {resolveEmojiSlot} from '../emoji-rail-width.ts';
import {
	loadConfig,
	determineProfileForInput,
	type PappardelleConfig,
	type ProfileSelection,
} from '../config.ts';
import {
	buildProfileOptions,
	computePickerWindow,
	focusFrame,
	handleProfilePickerKey,
	resolvePromptSubmit,
	PICKER_MAX_VISIBLE,
	type ProfileOption,
} from '../profile-picker.ts';

interface Props {
	onSubmit: (prompt: string, profileName: string | null) => void;
	onCancel: () => void;
	/**
	 * Columns available to the dialog. Callers inside tmux should pass the pane
	 * width — `stdout.columns` can be a full terminal-width stale value right
	 * after a split, which would run the hand-drawn top border past the pane
	 * edge and wrap it onto its own line.
	 */
	availableWidth?: number;
}

export default function PromptDialog({
	onSubmit,
	onCancel,
	availableWidth,
}: Props) {
	const [prompt, setPrompt] = useState('');
	// Both boxes are always on screen; this is purely which one has focus.
	const [isPicking, setIsPicking] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);

	const {stdout} = useStdout();
	const width = dialogWidth(availableWidth, stdout?.columns);

	// Load config once
	const config = useMemo((): PappardelleConfig | null => {
		try {
			return loadConfig();
		} catch {
			return null;
		}
	}, []);

	// Live preview of what the first Enter will do. Deferred inputs (issue keys)
	// still say so and still spawn on that one Enter; everything else advertises
	// the profile the picker will preselect.
	const preview = useMemo((): ProfileSelection | null => {
		if (!config) return null;
		return determineProfileForInput(config, prompt);
	}, [config, prompt]);
	const opensPicker = preview?.kind === 'resolved';

	// Derived from the current prompt rather than snapshotted on Enter, because
	// the list is visible while you type and has to re-rank as you go. Once the
	// picker takes focus the text input is frozen, so the list is stable for as
	// long as a selection can move within it.
	const options = useMemo(
		() => (config ? buildProfileOptions(config, prompt) : []),
		[config, prompt],
	);

	// While typing, the preselected row IS the answer the old "Profile:" line
	// used to spell out, so it always tracks the top of the list; the stored
	// index only matters once the picker has focus.
	const activeIndex = isPicking ? selectedIndex : 0;

	useInput(
		(_input, key) => {
			if (key.escape) {
				onCancel();
			}
		},
		{isActive: !isPicking},
	);

	useInput(
		(input, key) => {
			const result = handleProfilePickerKey(
				input,
				key,
				selectedIndex,
				options.length,
			);
			switch (result.action) {
				case 'move': {
					setSelectedIndex(result.index);
					break;
				}

				case 'submit': {
					const chosen = options[result.index];
					if (chosen) onSubmit(prompt.trim(), chosen.name);
					break;
				}

				case 'back': {
					// First Esc hands focus back to the prompt; a second one (handled by
					// the other useInput, now re-armed) cancels the dialog.
					setIsPicking(false);
					setSelectedIndex(0);
					break;
				}

				case 'ignore': {
					break;
				}
			}
		},
		{isActive: isPicking},
	);

	const handlePromptSubmit = (value: string) => {
		const decision = resolvePromptSubmit(config, value);
		switch (decision.kind) {
			case 'none': {
				break;
			}

			case 'spawn': {
				onSubmit(value.trim(), decision.profileName);
				break;
			}

			case 'pick': {
				setIsPicking(true);
				setSelectedIndex(0);
				break;
			}
		}
	};

	const promptFrame = focusFrame(!isPicking);
	const pickerFrame = focusFrame(isPicking);

	return (
		<Box flexDirection="column">
			<TitledBox
				title="+ New Session"
				borderColor="green"
				titleColor="greenBright"
				borderStyle={promptFrame.borderStyle}
				isDim={promptFrame.isDim}
				width={width}
			>
				<Box marginBottom={1} flexDirection="column">
					<Text dimColor>Enter a prompt or issue key:</Text>
					<Text dimColor>
						- <Text color="cyan">STA-123</Text> or <Text color="cyan">123</Text>{' '}
						= open workspace for existing issue
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
						onSubmit={handlePromptSubmit}
						placeholder="STA-123, 123, or describe the task..."
						isFocused={!isPicking}
					/>
				</Box>

				{!isPicking && (
					<Box marginTop={1}>
						<Text dimColor>
							Press <Text color="green">Enter</Text> to{' '}
							{opensPicker ? 'choose a profile' : 'start'},{' '}
							<Text color="yellow">Esc</Text> to cancel
						</Text>
					</Box>
				)}
			</TitledBox>

			<ProfilePicker
				options={options}
				selectedIndex={activeIndex}
				width={width}
				frame={pickerFrame}
				isFocused={isPicking}
				deferredLabel={
					preview?.kind === 'deferred' ? preview.displayName : undefined
				}
			/>
		</Box>
	);
}

function ProfilePicker({
	options,
	selectedIndex,
	width,
	frame,
	isFocused,
	deferredLabel,
}: {
	options: ProfileOption[];
	selectedIndex: number;
	width: number;
	frame: {borderStyle: 'double' | 'round'; isDim: boolean};
	isFocused: boolean;
	/**
	 * Set for issue-key / bare-number / Linear-URL inputs, where there is no
	 * choice to make — the profile comes from the fetched issue's tracker
	 * project. The box stays on screen (it always does) but shows a single
	 * inert row instead of a list, so it's visibly not somewhere Enter stops.
	 */
	deferredLabel?: string;
}) {
	const {start, end, above, below} = computePickerWindow(
		options.length,
		selectedIndex,
		PICKER_MAX_VISIBLE,
	);

	return (
		<Box flexDirection="column">
			<TitledBox
				title="Profile"
				borderColor="green"
				titleColor="greenBright"
				borderStyle={frame.borderStyle}
				isDim={frame.isDim}
				width={width}
				paddingY={0}
			>
				{deferredLabel ? (
					<Box>
						<Text dimColor>{'  '}</Text>
						<Text dimColor italic>
							{deferredLabel}
						</Text>
					</Box>
				) : null}
				{!deferredLabel && above > 0 && <Text dimColor>↑ {above} more</Text>}
				{!deferredLabel &&
					options.slice(start, end).map((option, offset) => {
						const index = start + offset;
						const isSelected = index === selectedIndex;
						// Same slot the ticket rail uses, so a profile wears the same
						// glyph wherever it appears. Sits right of the selection caret
						// (which owns column 0 for every row) and left of the label.
						const slot = resolveEmojiSlot(option.emoji);
						return (
							<Box key={option.name}>
								<Text
									color={isSelected ? 'green' : undefined}
									bold={isSelected}
								>
									{isSelected ? '❯ ' : '  '}
								</Text>
								{slot ? (
									<>
										<Text>{slot.text}</Text>
										{slot.needsSeparator ? <Text> </Text> : null}
									</>
								) : null}
								<Text
									color={isSelected ? 'green' : undefined}
									bold={isSelected}
								>
									{option.displayName}
								</Text>
								{option.matchedKeywords.length > 0 && (
									<Text dimColor> ← {option.matchedKeywords.join(', ')}</Text>
								)}
								{option.enforced && <Text color="magenta"> (enforced)</Text>}
								{option.isDefault && option.matchedKeywords.length === 0 && (
									<Text dimColor> (default)</Text>
								)}
							</Box>
						);
					})}
				{!deferredLabel && below > 0 && <Text dimColor>↓ {below} more</Text>}
			</TitledBox>

			{isFocused ? (
				<Box paddingX={2}>
					<Text dimColor>
						<Text color="green">↑/↓</Text> select ·{' '}
						<Text color="green">Enter</Text> start ·{' '}
						<Text color="yellow">Esc</Text> back
					</Text>
				</Box>
			) : null}
		</Box>
	);
}
