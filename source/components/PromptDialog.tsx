import React, {useState, useMemo, useRef} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import TextInput from './TextInput.tsx';
import TitledBox from './TitledBox.tsx';
import ConfirmDialog from './ConfirmDialog.tsx';
import {dialogWidth} from './dialog-width.ts';
import {resolveEmojiSlot} from '../emoji-rail-width.ts';
import {maybeStripSkinTones} from '../tmux-skin-tone.ts';
import {
	loadConfig,
	determineProfileForInput,
	listAgentProfiles,
	loadAgentProfileSources,
	resolveAgentProfileName,
	type PappardelleConfig,
	type ProfileSelection,
} from '../config.ts';
import {createIssueTracker} from '../providers/index.ts';
import type {IssueTrackerProvider} from '../providers/types.ts';
import {
	applySkillCompletion,
	clampSelection,
	reanchorSelection,
	handleSkillListKey,
	handleSkillPickerKey,
	matchSkills,
	skillQuery,
	skillTokenLength,
	SKILL_PICKER_MAX_VISIBLE,
	type SkillEntry,
} from '../skill-completion.ts';
import {
	pickerOptions,
	computePickerWindow,
	filterProfileOptions,
	focusFrame,
	handleFilterablePickerKey,
	resolvePromptSubmit,
	PICKER_MAX_VISIBLE,
	type FilterablePickerState,
	type ProfileOption,
} from '../profile-picker.ts';
import {useSkillSnapshot} from '../use-skill-snapshot.ts';
import {pickAgentProfileInPopup} from '../agent-profile-popup.ts';
import {ReadyWorkList, useReadyWork} from './ReadyWork.tsx';
import {INPUT_INDEX, resolveSubmission} from './ready-picker.ts';
import {promptDialogLayout} from './prompt-dialog-layout.ts';

/** React key for the profile-less row, which has no profile name to use. */
const DEFERRED_ROW_KEY = '__deferred__';

function rowKey(option: ProfileOption): string {
	return option.name ?? DEFERRED_ROW_KEY;
}

interface Props {
	onSubmit: (
		prompt: string,
		profileName: string | null,
		inputIsIssueKey: boolean,
		agentProfileName: string | null,
	) => void;
	onCancel: () => void;
	/**
	 * Columns available to the dialog. Callers inside tmux should pass the pane
	 * width; `stdout.columns` can be a full terminal-width stale value right
	 * after a split, which would run the hand-drawn top border past the pane
	 * edge and wrap it onto its own line.
	 */
	availableWidth?: number;
	/** Rows available to the dialog, which drops to a compact layout to fit. */
	availableHeight?: number;
}

export default function PromptDialog({
	onSubmit,
	onCancel,
	availableWidth,
	availableHeight,
}: Props) {
	const [prompt, setPrompt] = useState('');
	// Both boxes are always on screen; this is purely which one has focus.
	const [isPicking, setIsPicking] = useState(false);
	const [pickerState, setPickerState] = useState<FilterablePickerState>({
		query: null,
		index: 0,
	});
	// Keyed by row so an override stays with its profile while the list
	// re-ranks under further typing.
	const [agentOverrides, setAgentOverrides] = useState<Record<string, string>>(
		{},
	);

	// Escape closes the completion list without clearing what you typed, so the
	// dismissal has to be remembered against the exact text it was made for:
	// the next keystroke is a new query and deserves a fresh list.
	const [dismissedFor, setDismissedFor] = useState<string | null>(null);
	const [completionIndex, setCompletionIndex] = useState(0);
	// Enter moves the focus into the Skills box, which freezes the text input
	// and buys back `j`/`k` and Enter itself. Tab never needs this: it accepts
	// from wherever you are.
	const [isPickingSkill, setIsPickingSkill] = useState(false);

	// Resolved once. `createIssueTracker` throws when no provider is configured,
	// and every capability the dialog gates on — ready listing, closing — is a
	// question about this one object, so it is the only place that has to ask.
	const tracker = useMemo((): IssueTrackerProvider | null => {
		try {
			return createIssueTracker();
		} catch {
			return null;
		}
	}, []);

	const {stdout} = useStdout();
	const width = dialogWidth(availableWidth, stdout?.columns);

	const skills = useSkillSnapshot();

	const query = skillQuery(prompt);
	const completions = useMemo(
		() => (query === null ? [] : matchSkills(skills, query)),
		[skills, query],
	);
	const seenSkills = useRef(skills);
	const highlightedName = useRef<string | undefined>(undefined);
	if (seenSkills.current !== skills) {
		seenSkills.current = skills;
		const anchored = reanchorSelection(highlightedName.current, completions);
		if (anchored !== completionIndex) setCompletionIndex(anchored);
	}

	// Cyan, the Skills box's own color, so a painted name reads as "this is one
	// of those". Survives the space that closes the list, which is the point:
	// past that space the list is gone and the color is the only confirmation
	// left that the name is real.
	const highlight = useMemo(
		() => ({length: skillTokenLength(prompt, skills), color: 'cyan' as const}),
		[prompt, skills],
	);

	const isCompleting =
		!isPicking &&
		query !== null &&
		completions.length > 0 &&
		dismissedFor !== prompt;
	// Derived, never trusted from state alone: if the list closed underneath a
	// focused picker the focus has nowhere to be, and the prompt takes it back.
	const isSkillFocused = isCompleting && isPickingSkill;

	const acceptCompletion = (index: number) => {
		const chosen = completions[clampSelection(index, completions.length)];
		if (!chosen) return;
		setPrompt(applySkillCompletion(chosen.name));
		setCompletionIndex(0);
		// The accepted text ends in a space, so the list is already closed by the
		// time this renders; the focus has to come home with it.
		setIsPickingSkill(false);
	};

	// Load config once
	const config = useMemo((): PappardelleConfig | null => {
		try {
			return loadConfig();
		} catch {
			return null;
		}
	}, []);

	const ready = useReadyWork(
		tracker,
		!isPicking && !isCompleting && !isSkillFocused,
	);
	// The close confirmation takes over the whole dialog, so every other keymap
	// stands down while it is up.
	const isPromptStage = !isPicking && ready.closeTarget === null;

	const effectiveInput =
		resolveSubmission(prompt, ready.identifiers, ready.index) ?? '';

	// Live preview of what the first Enter will do. Deferred inputs (issue keys)
	// still say so and still spawn on that one Enter; everything else advertises
	// the profile the picker will preselect.
	const preview = useMemo((): ProfileSelection | null => {
		if (!config) return null;
		return determineProfileForInput(config, effectiveInput);
	}, [config, effectiveInput]);
	const canOverrideAgent = useMemo(
		() =>
			Boolean(process.env['TMUX']) &&
			config !== null &&
			listAgentProfiles(config, {}).length > 1,
		[config],
	);
	const opensPicker =
		preview?.kind === 'resolved' ||
		(preview?.kind === 'deferred' && (preview.canPick || canOverrideAgent));

	// Derived from the current prompt rather than snapshotted on Enter, because
	// the list is visible while you type and has to re-rank as you go. Once the
	// picker takes focus the text input is frozen, so the list is stable for as
	// long as a selection can move within it.
	const options = useMemo(
		() =>
			config ? pickerOptions(config, effectiveInput, canOverrideAgent) : [],
		[config, effectiveInput, canOverrideAgent],
	);

	const shownOptions =
		isPicking && pickerState.query
			? filterProfileOptions(options, pickerState.query)
			: options;

	// While typing, the preselected row IS the answer the old "Profile:" line
	// used to spell out, so it always tracks the top of the list; the stored
	// index only matters once the picker has focus.
	const activeIndex = isPicking ? pickerState.index : 0;

	useInput(
		(_input, key) => {
			if (!key.escape) return;
			// First Esc dismisses the completion list; a second one (now that the
			// list is gone) cancels the dialog. Mirrors the profile picker's
			// two-stage Esc so the key never means two things at once.
			if (isCompleting) {
				setDismissedFor(prompt);
				setCompletionIndex(0);
				return;
			}
			onCancel();
		},
		{isActive: isPromptStage && !isSkillFocused},
	);

	// Arrows and Tab. The text input keeps focus while the list is open, so
	// every printable key still has to reach it.
	useInput(
		(_input, key) => {
			const result = handleSkillPickerKey(
				key,
				completionIndex,
				completions.length,
			);
			if (result.action === 'move') {
				setCompletionIndex(result.index);
			} else if (result.action === 'accept') {
				acceptCompletion(result.index);
			}
		},
		{isActive: isCompleting && !isSkillFocused},
	);

	// The same list once it has the focus. The text input is frozen here, so
	// this map can afford `j`/`k` and Enter.
	useInput(
		(input, key) => {
			const result = handleSkillListKey(
				input,
				key,
				completionIndex,
				completions.length,
			);
			switch (result.action) {
				case 'move': {
					setCompletionIndex(result.index);
					break;
				}

				case 'accept': {
					acceptCompletion(result.index);
					break;
				}

				case 'back': {
					// The list stays open; only the focus goes back. The Esc after this
					// one dismisses the list, and the one after that cancels the dialog.
					setIsPickingSkill(false);
					break;
				}

				case 'ignore': {
					break;
				}
			}
		},
		{isActive: isSkillFocused},
	);

	useInput(
		(input, key) => {
			const result = handleFilterablePickerKey(
				pickerState,
				input,
				key,
				shownOptions.length,
			);
			setPickerState(result.state);
			switch (result.action) {
				case 'submit': {
					const chosen = shownOptions[result.state.index];
					if (chosen) {
						onSubmit(
							effectiveInput.trim(),
							chosen.name,
							ready.onRow,
							agentOverrides[rowKey(chosen)] ?? null,
						);
					}

					break;
				}

				case 'select': {
					// Back to the full list with the match highlighted, so starting the
					// session (or `a`) is still its own keystroke.
					const chosen = shownOptions[result.state.index];
					setPickerState({
						query: null,
						index: chosen ? Math.max(0, options.indexOf(chosen)) : 0,
					});
					break;
				}

				case 'agent': {
					const option = shownOptions[result.state.index];
					if (option && config) void chooseAgentProfile(option, config);
					break;
				}

				case 'back': {
					// First Esc hands focus back to the prompt; a second one (handled by
					// the other useInput, now re-armed) cancels the dialog.
					setIsPicking(false);
					setPickerState({query: null, index: 0});
					break;
				}

				case undefined: {
					break;
				}
			}
		},
		{isActive: isPicking && ready.closeTarget === null},
	);

	const chooseAgentProfile = async (
		option: ProfileOption,
		loadedConfig: PappardelleConfig,
	) => {
		const key = rowKey(option);
		const agentProfiles = listAgentProfiles(
			loadedConfig,
			loadAgentProfileSources(),
		);
		// The deferred row's profile isn't known until idow fetches the issue, so
		// it gets a row of its own, named '', that leaves the choice to idow.
		const profileDefault =
			option.kind === 'profile'
				? resolveAgentProfileName(
						loadedConfig,
						undefined,
						option.name ?? undefined,
					)
				: '';
		const name = await pickAgentProfileInPopup({
			options:
				option.kind === 'profile'
					? agentProfiles
					: [
							{name: '', source: "whichever the issue's profile uses"},
							...agentProfiles,
						],
			selected: agentOverrides[key] ?? profileDefault,
			profileDefault,
		});
		if (name === null) return;
		setAgentOverrides(current => {
			const {[key]: _previous, ...rest} = current;
			return name === profileDefault ? rest : {...rest, [key]: name};
		});
	};

	// The list re-ranks on every keystroke, so an index parked deep in a long
	// list would point past the end of a short one. Rendering and acceptance
	// both read this, or Enter highlights one row and accepts nothing.
	const activeCompletion = clampSelection(completionIndex, completions.length);
	highlightedName.current = completions[activeCompletion]?.name;

	const handlePromptSubmit = (value: string) => {
		// Enter belongs to the completion list while it is open, but only to move
		// the focus there. Tab is what accepts. This way one Enter never both
		// rewrites the prompt and leaves you unsure what the next Enter will do.
		if (isCompleting) {
			setIsPickingSkill(true);
			return;
		}

		const resolved = resolveSubmission(value, ready.identifiers, ready.index);
		if (resolved === null) return;

		const decision = resolvePromptSubmit(config, resolved, canOverrideAgent);
		switch (decision.kind) {
			case 'none': {
				break;
			}

			case 'spawn': {
				onSubmit(resolved, decision.profileName, ready.onRow, null);
				break;
			}

			case 'pick': {
				setIsPicking(true);
				setPickerState({query: null, index: 0});
				break;
			}
		}
	};

	if (ready.closeTarget) {
		const {identifier, title} = ready.closeTarget.issue;
		return (
			<ConfirmDialog
				title="Close Issue"
				message={`Close ${identifier}?`}
				detail={title}
				processingMessage={`Closing ${identifier}…`}
				onConfirm={ready.confirmClose}
				onCancel={ready.cancelClose}
			/>
		);
	}

	// The heavy outline is the only thing saying where a keystroke lands, so the
	// prompt gives it up to whichever picker took the focus from it.
	const promptFrame = focusFrame(
		!isPicking && !isSkillFocused && ready.index === INPUT_INDEX,
	);
	const pickerFrame = focusFrame(isPicking);
	const deferredLabel =
		preview?.kind === 'deferred' && !preview.canPick
			? preview.displayName
			: undefined;
	const layout = promptDialogLayout(
		availableHeight,
		isCompleting ? SKILL_PICKER_MAX_VISIBLE : PICKER_MAX_VISIBLE,
		{
			readyCount: ready.issues.length,
			isReadyLoading: ready.loading,
			hasError: ready.errorMessage !== null,
			pickerCount: isCompleting
				? completions.length
				: deferredLabel
					? 1
					: options.length,
		},
	);

	return (
		<Box flexDirection="column">
			<TitledBox
				title="+ New Session"
				borderColor="green"
				titleColor="greenBright"
				borderStyle={promptFrame.borderStyle}
				isDim={promptFrame.isDim}
				width={width}
				paddingY={layout.paddingY}
			>
				<Box
					marginBottom={1}
					flexDirection="column"
					display={layout.showInstructions ? 'flex' : 'none'}
				>
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
						isFocused={!isPicking && !isSkillFocused}
						isShowingCursor={ready.index === INPUT_INDEX}
						highlight={highlight}
					/>
				</Box>

				{ready.errorMessage && (
					<Box marginTop={1}>
						<Text color="red">{ready.errorMessage}</Text>
					</Box>
				)}

				{!isPicking && !isSkillFocused && (
					<Box marginTop={1}>
						<Text dimColor>
							{isCompleting ? (
								<>
									Press <Text color="cyan">Tab</Text> to complete,{' '}
									<Text color="green">Enter</Text> for the list,{' '}
									<Text color="yellow">Esc</Text> to dismiss
								</>
							) : (
								<>
									Press <Text color="green">Enter</Text> to{' '}
									{opensPicker ? 'choose a profile' : 'start'},{' '}
									<Text color="yellow">Esc</Text> to cancel
								</>
							)}
						</Text>
					</Box>
				)}
			</TitledBox>

			<ReadyWorkList
				ready={ready}
				width={width}
				isFocused={!isPicking && ready.index >= 0}
				hasHints={!isPicking}
				maxVisible={layout.readyMaxVisible}
			/>
			{isCompleting ? (
				<SkillPicker
					entries={completions}
					selectedIndex={activeCompletion}
					width={width}
					frame={focusFrame(isSkillFocused)}
					isFocused={isSkillFocused}
					maxVisible={layout.pickerMaxVisible}
				/>
			) : (
				<ProfilePicker
					options={shownOptions}
					query={isPicking ? pickerState.query : null}
					agentOverrides={agentOverrides}
					selectedIndex={activeIndex}
					width={width}
					frame={pickerFrame}
					isFocused={isPicking}
					deferredLabel={deferredLabel}
					maxVisible={layout.pickerMaxVisible}
				/>
			)}
		</Box>
	);
}

function ProfilePicker({
	options,
	query,
	agentOverrides,
	selectedIndex,
	width,
	frame,
	isFocused,
	deferredLabel,
	maxVisible,
}: {
	options: ProfileOption[];
	/** The `/` filter's text, null when not filtering. */
	query: string | null;
	agentOverrides: Record<string, string>;
	selectedIndex: number;
	width: number;
	frame: {borderStyle: 'double' | 'round'; isDim: boolean};
	isFocused: boolean;
	/**
	 * Set for bare numbers and for issue keys whose prefix no profile claims,
	 * where there is no choice to make — the profile comes from the fetched
	 * issue's tracker project. A claimed prefix gets the real list instead.
	 * The box stays on screen (it always does) but shows a single
	 * inert row instead of a list, so it's visibly not somewhere Enter stops.
	 */
	deferredLabel?: string;
	maxVisible: number;
}) {
	const {start, end, above, below} = computePickerWindow(
		options.length,
		selectedIndex,
		maxVisible,
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
				{!deferredLabel && options.length === 0 && (
					<Text dimColor>{'  '}No match</Text>
				)}
				{!deferredLabel &&
					options.slice(start, end).map((option, offset) => {
						const index = start + offset;
						const isSelected = index === selectedIndex;
						// Same slot the ticket rail uses, so a profile wears the same
						// glyph wherever it appears. Sits right of the selection caret
						// (which owns column 0 for every row) and left of the label.
						const slot = resolveEmojiSlot(maybeStripSkinTones(option.emoji));
						const agentOverride = agentOverrides[rowKey(option)];
						return (
							<Box key={rowKey(option)}>
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
									italic={option.kind === 'deferred'}
								>
									{option.displayName}
								</Text>
								{option.matchedKeywords.length > 0 && (
									<Text dimColor> ← {option.matchedKeywords.join(', ')}</Text>
								)}
								{option.matchedPrefix && (
									<Text dimColor> ← {option.matchedPrefix}</Text>
								)}
								{option.enforced && <Text color="magenta"> (enforced)</Text>}
								{option.isDefault && option.matchedKeywords.length === 0 && (
									<Text dimColor> (default)</Text>
								)}
								{agentOverride && <Text color="cyan"> → {agentOverride}</Text>}
							</Box>
						);
					})}
				{!deferredLabel && below > 0 && <Text dimColor>↓ {below} more</Text>}
			</TitledBox>

			{isFocused && query !== null ? (
				<Box paddingX={2}>
					<Text wrap="truncate-end">
						<Text color="cyan">/{query}</Text>
						<Text inverse> </Text>
						<Text dimColor>
							{' '}
							· <Text color="green">Enter</Text> select ·{' '}
							<Text color="yellow">Esc</Text> clear
						</Text>
					</Text>
				</Box>
			) : isFocused ? (
				<Box paddingX={2}>
					<Text dimColor>
						<Text color="green">↑/↓</Text> select · <Text color="cyan">/</Text>{' '}
						filter ·{' '}
						{process.env['TMUX'] ? (
							<>
								<Text color="cyan">a</Text> agent ·{' '}
							</>
						) : null}
						<Text color="green">Enter</Text> start ·{' '}
						<Text color="yellow">Esc</Text> back
					</Text>
				</Box>
			) : null}
		</Box>
	);
}

/**
 * The slash-command list.
 *
 * It starts unfocused, because the text input owns the cursor for as long as
 * you are still typing the name. Enter hands it the focus, which freezes the
 * input and lets the arrows, `j`/`k`, and Enter itself work on the list. Tab
 * accepts from either side, so the focus is never something you have to take
 * before you can finish a name.
 */
function SkillPicker({
	entries,
	selectedIndex,
	width,
	frame,
	isFocused,
	maxVisible,
}: {
	entries: SkillEntry[];
	selectedIndex: number;
	width: number;
	frame: {borderStyle: 'double' | 'round'; isDim: boolean};
	isFocused: boolean;
	maxVisible: number;
}) {
	const {start, end, above, below} = computePickerWindow(
		entries.length,
		selectedIndex,
		maxVisible,
	);

	return (
		<Box flexDirection="column">
			<TitledBox
				title="Skills"
				borderColor="cyan"
				titleColor="cyanBright"
				borderStyle={frame.borderStyle}
				isDim={frame.isDim}
				width={width}
				paddingY={0}
			>
				{above > 0 && <Text dimColor>↑ {above} more</Text>}
				{entries.slice(start, end).map((entry, offset) => {
					const index = start + offset;
					const isSelected = index === selectedIndex;
					return (
						<Box key={`${entry.source}:${entry.name}`}>
							<Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
								{isSelected ? '❯ ' : '  '}/{entry.name}
							</Text>
							{entry.source === 'user' && <Text dimColor> (user)</Text>}
						</Box>
					);
				})}
				{below > 0 && <Text dimColor>↓ {below} more</Text>}
			</TitledBox>

			<Box paddingX={2}>
				<Text dimColor>
					{isFocused ? (
						<>
							<Text color="cyan">↑/↓</Text> select ·{' '}
							<Text color="cyan">Enter</Text> complete ·{' '}
							<Text color="yellow">Esc</Text> back
						</>
					) : (
						<>
							<Text color="cyan">↑/↓</Text> select ·{' '}
							<Text color="cyan">Tab</Text> complete ·{' '}
							<Text color="yellow">Esc</Text> dismiss
						</>
					)}
				</Text>
			</Box>
		</Box>
	);
}
