import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {
	buildStateChoices,
	choiceKey,
	choiceLabel,
	closeSpaceContent,
	cycleChoice,
	defaultChoiceKey,
	type StateChoice,
} from '../close-state-choice.ts';
import {createIssueTracker} from '../providers/index.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerState,
} from '../providers/types.ts';
import ConfirmDialog from './ConfirmDialog.tsx';

export function canPickCloseState(
	tracker: IssueTrackerProvider | null,
): tracker is IssueTrackerProvider &
	Required<
		Pick<IssueTrackerProvider, 'listStates' | 'setIssueState' | 'closeIssue'>
	> {
	return (
		typeof tracker?.listStates === 'function' &&
		typeof tracker.setIssueState === 'function' &&
		typeof tracker.closeIssue === 'function'
	);
}

/**
 * Loaded by the dialog itself rather than passed in: inside a tmux popup the
 * dialog's props arrive once, at launch, so a list fetched afterwards by the
 * TUI could never reach it.
 */
function useCloseStates(
	tracker: IssueTrackerProvider | null,
): TrackerState[] | null {
	const [states, setStates] = useState<TrackerState[] | null>(null);

	useEffect(() => {
		if (!canPickCloseState(tracker)) return;
		let cancelled = false;
		void (async () => {
			try {
				const loaded = await tracker.listStates();
				if (!cancelled) setStates(loaded);
			} catch {
				// The fallback choices still close the issue.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [tracker]);

	return states;
}

function defaultTracker(): IssueTrackerProvider | null {
	try {
		return createIssueTracker();
	} catch {
		return null;
	}
}

type Props = {
	spaceName: string;
	currentIssue: TrackerIssue | null;
	/** `choice` is undefined when the tracker can't set states. */
	onConfirm: (choice?: StateChoice) => void | PromiseLike<void>;
	onCancel: () => void;
	isFullHeight?: boolean;
	tracker?: IssueTrackerProvider | null;
};

export default function CloseSpaceDialog({
	spaceName,
	currentIssue,
	onConfirm,
	onCancel,
	isFullHeight,
	tracker: trackerOverride,
}: Props) {
	const tracker = useMemo(
		() => (trackerOverride === undefined ? defaultTracker() : trackerOverride),
		[trackerOverride],
	);
	const pickable = canPickCloseState(tracker);
	const states = useCloseStates(tracker);
	const choices = useMemo(
		() => buildStateChoices(states, currentIssue),
		[states, currentIssue],
	);
	// Held by key, not index, so it survives the list growing once states load.
	const [selectedKey, setSelectedKey] = useState<string | null>(null);

	const keys = choices.map(choice => choiceKey(choice));
	const effectiveKey =
		selectedKey !== null && keys.includes(selectedKey)
			? selectedKey
			: defaultChoiceKey(choices);
	const index = Math.max(0, keys.indexOf(effectiveKey));
	const selected = choices[index]!;

	useInput(
		(_input, key) => {
			if (!key.leftArrow && !key.rightArrow) return;
			const next = cycleChoice(
				index,
				choices.length,
				key.leftArrow ? 'left' : 'right',
			);
			setSelectedKey(keys[next]!);
		},
		{isActive: pickable},
	);

	const content = closeSpaceContent(spaceName);

	if (!pickable) {
		return (
			<ConfirmDialog
				{...content}
				isFullHeight={isFullHeight}
				onConfirm={async () => onConfirm()}
				onCancel={onCancel}
			/>
		);
	}

	return (
		<ConfirmDialog
			{...content}
			isFullHeight={isFullHeight}
			hint={
				<Text dimColor>
					<Text color="cyan">←/→</Text> change state ·{' '}
					<Text color="green">y/Enter</Text> confirm ·{' '}
					<Text color="yellow">n/Esc</Text> cancel
				</Text>
			}
			onConfirm={async () => {
				await onConfirm(selected);
			}}
			onCancel={onCancel}
		>
			<Box marginBottom={1}>
				{/* tmux can't resize an open popup, so a long status name must not wrap. */}
				<Text wrap="truncate-end">
					Issue state: <Text color="cyan">‹ {choiceLabel(selected)} ›</Text>
				</Text>
			</Box>
		</ConfirmDialog>
	);
}
