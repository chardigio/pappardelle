import {CliRenderEvents} from '@opentui/core';
import {useKeyboard, useRenderer} from '@opentui/react';
import {shortcutKey} from '../tui-key.ts';
import {textAttributes, terminalColor, dimText} from '../tui-style.ts';
import {useEffect, useState, type ReactNode} from 'react';

import ClaudeAnimation from './ClaudeAnimation.tsx';
import Gap from './Gap.tsx';
import {
	isThenable,
	parseConfirmDialogInput,
	runConfirmSafely,
} from './confirm-dialog-input.ts';

interface Props {
	title: string;
	message: string;
	detail?: string;
	/**
	 * When `onConfirm` returns a Promise, the dialog stays mounted and switches
	 * to a loading state until the parent unmounts it. The pre-deinit deletion
	 * flow (STA-1373) is the motivating case: closing a space runs user-supplied
	 * shell hooks that can take several seconds, and the previous "hide dialog
	 * immediately, then await" sequence made the TUI look frozen.
	 */
	onConfirm: () => void | PromiseLike<void>;
	onCancel: () => void;
	/**
	 * Override the loading-state message. Defaults to "Processing…" — callers
	 * should pass something specific ("Closing space STA-123…") so the user
	 * knows which long-running action they triggered.
	 */
	processingMessage?: string;
	/** Stretch to the parent's height, for a tmux popup sized to fit. */
	isFullHeight?: boolean;
	/** Extra rows between the message and the detail. */
	children?: ReactNode;
	/** Replaces the y/n hint, for a dialog that adds keys of its own. */
	hint?: ReactNode;
	/**
	 * The confirmed action removes something: closing or deleting a space, or
	 * discarding work. Only these get the red frame, so it keeps meaning
	 * "careful" instead of marking every question.
	 */
	isDestructive: boolean;
}

export default function ConfirmDialog({
	title,
	message,
	detail,
	onConfirm,
	onCancel,
	processingMessage,
	isFullHeight,
	children,
	hint,
	isDestructive,
}: Props) {
	// Snapshot the dialog's text when entering processing state. The parent's
	// props can shift mid-deletion — once `deleteSpace` finishes and the list
	// updates, `selectedIndex` may now point at the *next* space, so a naive
	// re-read of `processingMessage` would flicker to "Closing space [next-
	// ticket]…" for one frame before the dialog unmounts. Freezing on entry
	// keeps the user's mental model honest about which ticket is closing.
	const [processingFrame, setProcessingFrame] = useState<{
		title: string;
		message: string;
		detail?: string;
		status: string;
		confirm?: Props['onConfirm'];
	} | null>(null);
	const renderer = useRenderer();

	// A frame already in flight when the spinner committed was laid out without
	// it, so wait for one that started afterwards.
	const confirm = processingFrame?.confirm;
	useEffect(() => {
		if (!confirm) return;
		const committedAt = renderer.frameId;
		const onFrame = ({frameId}: {frameId: number}) => {
			if (frameId <= committedAt) return;
			renderer.off(CliRenderEvents.FRAME, onFrame);
			runConfirmSafely(confirm);
		};
		renderer.on(CliRenderEvents.FRAME, onFrame);
		return () => {
			renderer.off(CliRenderEvents.FRAME, onFrame);
		};
	}, [confirm, renderer]);

	useKeyboard(event => {
		const {input, key} = shortcutKey(event);
		const action = parseConfirmDialogInput(
			input,
			key,
			processingFrame !== null,
		);
		if (action === 'cancel') {
			onCancel();
		} else if (action === 'confirm') {
			if (processingMessage !== undefined) {
				// Caller has opted into the loading state: show the spinner and
				// run onConfirm only once a frame with it has been presented.
				// Async onConfirms (like workspace deletion) typically run a
				// chunk of synchronous setup — execSync `git rev-parse`, reading
				// `.pappardelle.yml`, walking profiles — *before* their first
				// await, and the dialog looks frozen if that runs before the
				// spinner is on screen (STA-1373).
				setProcessingFrame({
					title,
					message,
					detail,
					status: processingMessage,
					confirm: onConfirm,
				});
				// We intentionally don't reset processingFrame — the parent
				// owns the dialog's lifetime and unmounts us once its async
				// work finishes.
			} else {
				// No processingMessage: caller didn't signal that this is
				// long-running. Fall back to detect-after-call so any sync
				// confirm still works without a spinner flicker.
				const result = runConfirmSafely(onConfirm);
				if (isThenable(result)) {
					setProcessingFrame({title, message, detail, status: 'Processing…'});
				}
			}
		}
	});

	// The spinner takes the hint's row and the rest stays put, so a dialog in a
	// fixed-size tmux popup keeps filling it.
	const shown = processingFrame ?? {title, message, detail};

	return (
		<box
			border
			flexDirection="column"
			borderStyle={isDestructive ? 'double' : 'rounded'}
			borderColor={terminalColor(isDestructive ? 'red' : undefined)}
			flexGrow={isFullHeight ? 1 : 0}
			overflow="hidden"
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" flexShrink={0}>
				<text
					flexShrink={1}
					attributes={textAttributes({bold: true})}
					fg={terminalColor(isDestructive ? 'red' : undefined)}
				>
					{shown.title}
				</text>
			</box>
			<Gap />

			<box flexDirection="row" flexShrink={0}>
				<text fg={terminalColor()} flexShrink={1}>
					{shown.message}
				</text>
			</box>
			<Gap />

			{children}

			{shown.detail && (
				<>
					<box flexDirection="row" flexShrink={0}>
						<text {...dimText()}>{shown.detail}</text>
					</box>
					<Gap />
				</>
			)}

			{processingFrame ? (
				<box flexDirection="row" flexShrink={0}>
					<ClaudeAnimation />
					<text fg={terminalColor()} flexShrink={1}>
						{' '}
						{processingFrame.status}
					</text>
				</box>
			) : (
				<box flexDirection="row" flexShrink={0}>
					{hint ?? (
						<text {...dimText()}>
							Press <span fg={terminalColor('green')}>y</span> or{' '}
							<span fg={terminalColor('green')}>Enter</span> to confirm,{' '}
							<span fg={terminalColor('yellow')}>n</span> or{' '}
							<span fg={terminalColor('yellow')}>Esc</span> to cancel
						</text>
					)}
				</box>
			)}
		</box>
	);
}
