import {useKeyboard} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor, dimText} from '../tui-style.ts';
import {useEffect, useMemo, useState} from 'react';

import widestLine from 'widest-line';
import TitledBox from './TitledBox.tsx';
import {truncateToWidth} from '../truncate-to-width.ts';
import {maybeStripSkinTones, useTmuxSkinToneWide} from '../tmux-skin-tone.ts';
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
import {READY_MAX_VISIBLE} from './prompt-dialog-layout.ts';

const CLOSE_KEY = 'x';

const OPEN_KEY = 'i';

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
	// undefined, which collapses the picker to nothing.
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
	const openKeyActive = hasHighlightedRow(index);

	useKeyboard(event => {
		if (!(isActive && closeTarget === null)) return;
		const {input, key} = shortcutKey(event);
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
			void openIssueForKey(issue.identifier).then(result => {
				setErrorMessage(result.ok ? null : result.message);
			});
		}
	});

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
	maxVisible = READY_MAX_VISIBLE,
}: {
	ready: ReadyWork;
	/** Columns the list spans, which rows truncate their titles to. */
	width: number;
	/** Whether the cursor is in this list, which owns the heavy outline. */
	isFocused: boolean;
	hasHints: boolean;
	maxVisible?: number;
}) {
	const {issues, index} = ready;
	const window = useMemo(
		() => visibleWindow(index, issues.length, maxVisible),
		[index, issues.length, maxVisible],
	);
	const skinToneWide = useTmuxSkinToneWide();

	if (ready.loading) {
		return (
			<box flexDirection="row" paddingX={2}>
				<text {...dimText()}>Loading ready work…</text>
			</box>
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
				paddingY={0}
			>
				{window.start > 0 && <text {...dimText()}>↑ {window.start} more</text>}
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
						maybeStripSkinTones(issue.title.replace(/\s+/g, ' '), skinToneWide),
						titleWidth,
					);
					return (
						<box
							flexDirection="row"
							key={issue.identifier}
							height={1}
							overflow="hidden"
						>
							<text
								fg={terminalColor()}
								flexShrink={1}
								wrapMode="none"
								height={1}
							>
								<span fg={terminalColor('green')}>
									{isSelected ? '❯ ' : '  '}
								</span>
								<span
									attributes={textAttributes({bold: isSelected})}
									fg={terminalColor(isSelected ? 'green' : 'cyan')}
								>
									{identifier}
								</span>
								{title && (
									<span attributes={textAttributes({dim: !isSelected})}>
										{' '}
										{title}
									</span>
								)}
							</text>
						</box>
					);
				})}
				{window.end < issues.length && (
					<text {...dimText()}>↓ {issues.length - window.end} more</text>
				)}
			</TitledBox>

			{hasHints && (
				<box flexDirection="row" paddingX={2}>
					<text {...dimText()}>
						<span fg={terminalColor('green')}>↑/↓</span> pick up ready work
						{ready.openKeyActive && (
							<>
								{' · '}
								<span fg={terminalColor('green')}>{OPEN_KEY}</span> issue
							</>
						)}
						{ready.closeKeyActive && (
							<>
								{' · '}
								<span fg={terminalColor('green')}>{CLOSE_KEY}</span> close
							</>
						)}
					</text>
				</box>
			)}
		</>
	);
}
