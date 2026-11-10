import type {BoxRenderable} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {terminalColor, dimText} from '../tui-style.ts';
import {useEffect, useMemo, useRef, useState} from 'react';

import {
	buildStateChoices,
	choiceKey,
	choiceLabel,
	closeSpaceContent,
	cycleChoice,
	defaultChoiceKey,
	STATE_ROW_ONE_LINE_COLS,
	type StateChoice,
} from '../close-state-choice.ts';
import {createIssueTracker} from '../providers/index.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerState,
} from '../providers/types.ts';
import ConfirmDialog from './ConfirmDialog.tsx';
import Gap from './Gap.tsx';

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

	useKeyboard(event => {
		if (!pickable) return;
		const {input: _input, key} = shortcutKey(event);
		if (!key.leftArrow && !key.rightArrow) return;
		const next = cycleChoice(
			index,
			choices.length,
			key.leftArrow ? 'left' : 'right',
		);
		setSelectedKey(keys[next]!);
	});

	const content = closeSpaceContent(spaceName);
	const stateRow = useRef<BoxRenderable>(null);
	const [rowWidth, setRowWidth] = useState<number | undefined>(undefined);
	const isNarrow = rowWidth !== undefined && rowWidth < STATE_ROW_ONE_LINE_COLS;

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
				<text {...dimText()}>
					<span fg={terminalColor('cyan')}>←/→</span> change state ·{' '}
					<span fg={terminalColor('green')}>y/Enter</span> confirm ·{' '}
					<span fg={terminalColor('yellow')}>n/Esc</span> cancel
				</text>
			}
			onConfirm={async () => {
				await onConfirm(selected);
			}}
			onCancel={onCancel}
		>
			<box
				ref={stateRow}
				flexDirection={isNarrow ? 'column' : 'row'}
				flexShrink={0}
				onSizeChange={() => {
					if (stateRow.current) setRowWidth(stateRow.current.width);
				}}
			>
				<text fg={terminalColor()} flexShrink={0} wrapMode="none" height={1}>
					Issue state:{isNarrow ? '' : ' '}
				</text>
				<text
					fg={terminalColor('cyan')}
					flexShrink={1}
					wrapMode="none"
					height={1}
				>
					‹ {choiceLabel(selected)} ›
				</text>
			</box>
			<Gap />
		</ConfirmDialog>
	);
}
