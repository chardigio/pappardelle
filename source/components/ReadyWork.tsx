import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import widestLine from 'widest-line';
import TitledBox from './TitledBox.tsx';
import {truncateToWidth} from '../truncate-to-width.ts';
import {focusFrame} from '../profile-picker.ts';
import {openIssueForKey} from '../open-issue.ts';
import type {IssueTrackerProvider, TrackerIssue} from '../providers/types.ts';
import {
	INPUT_INDEX,
	canCloseHighlightedRow,
	hasHighlightedRow,
	moveSelection,
	selectionAfterRemoval,
	visibleWindow,
} from './ready-picker.ts';

const MAX_VISIBLE_SUGGESTIONS = 8;

const CLOSE_KEY = 'x';

// 'i' rather than 'o' to match the main list, where 'i' opens the issue and
// 'o' opens the workspace.
const OPEN_KEY = 'i';

/**
 * The ready-work list under the new-session prompt: what `bd ready` offers, the
 * cursor the prompt shares with it, and the two row actions.
 *
 * Split out of PromptDialog because it is a self-contained surface with its own
 * fetch, its own keymap and its own confirm step — none of which the prompt,
 * the skill completer or the profile picker have any reason to be edited for.
 */
export interface ReadyWork {
	issues: TrackerIssue[];
	loading: boolean;
	/** INPUT_INDEX when the caret is in the text field, else the row it is on. */
	index: number;
	identifiers: string[];
	/** True when the cursor sits on a row, so Enter submits that issue. */
	onRow: boolean;
	openKeyActive: boolean;
	closeKeyActive: boolean;
	errorMessage: string | null;
	/** Set while the close confirmation owns the screen. */
	closeTarget: {issue: TrackerIssue; index: number} | null;
	confirmClose: () => Promise<void>;
	cancelClose: () => void;
}

/**
 * `isActive` gates the keymap on the conditions the caller owns — whichever of
 * its other boxes has the focus — so the skill completer can take the arrows
 * back while it is open. The confirmation step is gated here instead, since the
 * state it turns on belongs to this hook.
 */
export function useReadyWork(
	tracker: IssueTrackerProvider | null,
	isActive: boolean,
): ReadyWork {
	const [issues, setIssues] = useState<TrackerIssue[]>([]);
	// Resolved up front so trackers without a ready query never flash a loading
	// row on their way to rendering nothing.
	const [loading, setLoading] = useState(
		() => typeof tracker?.listReadyIssues === 'function',
	);
	// The prompt field and this list share one cursor: INPUT_INDEX means the
	// caret is in the text field, 0..n-1 point at a suggestion.
	const [index, setIndex] = useState(INPUT_INDEX);
	const [closeTarget, setCloseTarget] = useState<{
		issue: TrackerIssue;
		index: number;
	} | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Trackers that can't answer "what's ready" cheaply leave listReadyIssues
	// undefined, which collapses the picker to nothing and leaves the dialog
	// exactly as it was before.
	useEffect(() => {
		let cancelled = false;

		const load = async () => {
			try {
				const ready = (await tracker?.listReadyIssues?.()) ?? [];
				if (!cancelled) setIssues(ready);
			} catch {
				// A tracker that cannot answer leaves the list empty; the prompt
				// above it still works.
				if (!cancelled) setIssues([]);
			} finally {
				if (!cancelled) setLoading(false);
			}
		};

		void load();
		return () => {
			cancelled = true;
		};
	}, [tracker]);

	const identifiers = useMemo(
		() => issues.map(issue => issue.identifier),
		[issues],
	);

	// Trackers that can't close an issue locally leave closeIssue undefined; the
	// keybinding and its hint disappear rather than failing on the keystroke.
	const closeKeyActive = canCloseHighlightedRow(
		typeof tracker?.closeIssue === 'function',
		index,
	);
	// Every tracker can show an issue somehow — a popup for the local-only ones,
	// a browser for the rest — so this needs no capability gate of its own.
	const openKeyActive = hasHighlightedRow(index);

	useInput(
		(input, key) => {
			if (key.downArrow || key.upArrow) {
				setIndex(current =>
					moveSelection(
						current,
						identifiers.length,
						key.downArrow ? 'down' : 'up',
					),
				);
				return;
			}

			if (key.ctrl || key.meta) return;

			const issue = issues[index];
			if (!issue) return;

			if (closeKeyActive && input === CLOSE_KEY) {
				setErrorMessage(null);
				setCloseTarget({issue, index});
				return;
			}

			if (openKeyActive && input === OPEN_KEY) {
				// Read-only, so the cursor stays where it is: the popup is a detour
				// on the way to picking this row up, not a replacement for it.
				const result = openIssueForKey(issue.identifier);
				setErrorMessage(result.ok ? null : result.message);
			}
		},
		{isActive: isActive && closeTarget === null},
	);

	const confirmClose = async () => {
		if (!closeTarget) return;
		const {issue, index: removed} = closeTarget;

		// closeIssue resolves false on every failure path rather than throwing,
		// so a false here is "bd said no", not "something blew up".
		const closed = (await tracker?.closeIssue?.(issue.identifier)) ?? false;
		if (closed) {
			const remaining = issues.filter(
				candidate => candidate.identifier !== issue.identifier,
			);
			setIssues(remaining);
			setIndex(selectionAfterRemoval(removed, remaining.length));
		} else {
			setErrorMessage(`Could not close ${issue.identifier}`);
		}

		setCloseTarget(null);
	};

	return {
		issues,
		loading,
		index,
		identifiers,
		onRow: hasHighlightedRow(index) && identifiers[index] !== undefined,
		openKeyActive,
		closeKeyActive,
		errorMessage,
		closeTarget,
		confirmClose,
		cancelClose: () => setCloseTarget(null),
	};
}

export function ReadyWorkList({
	ready,
	width,
	isFocused,
	hasHints,
}: {
	ready: ReadyWork;
	width: number;
	/** Whether the cursor is in this list, which owns the heavy outline. */
	isFocused: boolean;
	hasHints: boolean;
}) {
	const {issues, index} = ready;
	const window = useMemo(
		() => visibleWindow(index, issues.length, MAX_VISIBLE_SUGGESTIONS),
		[index, issues.length],
	);

	if (ready.loading) {
		return (
			<Box paddingX={2}>
				<Text dimColor>Loading ready work…</Text>
			</Box>
		);
	}

	if (issues.length === 0) return null;

	const frame = focusFrame(isFocused);
	const contentWidth = Math.max(0, width - 6);

	return (
		<>
			<TitledBox
				title={`Ready work (${issues.length})`}
				borderColor="green"
				titleColor="greenBright"
				borderStyle={frame.borderStyle}
				isDim={frame.isDim}
				width={width}
				paddingY={0}
			>
				{window.start > 0 && <Text dimColor>↑ {window.start} more</Text>}
				{issues.slice(window.start, window.end).map((issue, offset) => {
					const isSelected = window.start + offset === index;
					const identifier = truncateToWidth(
						issue.identifier,
						contentWidth - 2,
					);
					const titleWidth = Math.max(
						0,
						contentWidth - 3 - widestLine(identifier),
					);
					const title = truncateToWidth(
						issue.title.replace(/\s+/g, ' '),
						titleWidth,
					);
					return (
						<Box key={issue.identifier} height={1} overflow="hidden">
							<Text wrap="truncate">
								<Text color="green">{isSelected ? '❯ ' : '  '}</Text>
								<Text color={isSelected ? 'green' : 'cyan'} bold={isSelected}>
									{identifier}
								</Text>
								{title && <Text dimColor={!isSelected}> {title}</Text>}
							</Text>
						</Box>
					);
				})}
				{window.end < issues.length && (
					<Text dimColor>↓ {issues.length - window.end} more</Text>
				)}
			</TitledBox>

			{hasHints && (
				<Box paddingX={2}>
					<Text dimColor>
						<Text color="green">↑/↓</Text> pick up ready work
						{ready.openKeyActive && (
							<>
								{' · '}
								<Text color="green">{OPEN_KEY}</Text> issue
							</>
						)}
						{ready.closeKeyActive && (
							<>
								{' · '}
								<Text color="green">{CLOSE_KEY}</Text> close
							</>
						)}
					</Text>
				</Box>
			)}
		</>
	);
}
