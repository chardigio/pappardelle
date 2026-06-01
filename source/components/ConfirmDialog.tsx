import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import ClaudeAnimation from './ClaudeAnimation.tsx';
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
}

export default function ConfirmDialog({
	title,
	message,
	detail,
	onConfirm,
	onCancel,
	processingMessage,
}: Props) {
	// Snapshot the message + title when entering processing state. The parent's
	// props can shift mid-deletion — once `deleteSpace` finishes and the list
	// updates, `selectedIndex` may now point at the *next* space, so a naive
	// re-read of `processingMessage` would flicker to "Closing space [next-
	// ticket]…" for one frame before the dialog unmounts. Freezing on entry
	// keeps the user's mental model honest about which ticket is closing.
	const [processingFrame, setProcessingFrame] = useState<{
		title: string;
		message: string;
	} | null>(null);

	useInput((input, key) => {
		const action = parseConfirmDialogInput(
			input,
			key,
			processingFrame !== null,
		);
		if (action === 'cancel') {
			onCancel();
		} else if (action === 'confirm') {
			if (processingMessage !== undefined) {
				// Caller has opted into the loading state: enter it BEFORE
				// running onConfirm, then defer onConfirm to the next event-
				// loop tick so Ink can paint the spinner first. This matters
				// because async onConfirms (like workspace deletion) typically
				// run a chunk of synchronous setup — execSync `git rev-parse`,
				// reading `.pappardelle.yml`, walking profiles — *before*
				// hitting their first await. Without the deferral, that sync
				// prefix runs in the same JS turn as the keystroke and the
				// spinner doesn't appear until it's already done (STA-1373).
				setProcessingFrame({title, message: processingMessage});
				setImmediate(() => {
					runConfirmSafely(onConfirm);
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
					setProcessingFrame({title, message: 'Processing…'});
				}
			}
		}
	});

	if (processingFrame !== null) {
		return (
			<Box
				flexDirection="column"
				borderStyle="double"
				borderColor="red"
				paddingX={2}
				paddingY={1}
			>
				<Box marginBottom={1}>
					<Text bold color="red">
						{processingFrame.title}
					</Text>
				</Box>

				<Box>
					<ClaudeAnimation />
					<Text> {processingFrame.message}</Text>
				</Box>
			</Box>
		);
	}

	return (
		<Box
			flexDirection="column"
			borderStyle="double"
			borderColor="red"
			paddingX={2}
			paddingY={1}
		>
			<Box marginBottom={1}>
				<Text bold color="red">
					{title}
				</Text>
			</Box>

			<Box marginBottom={1}>
				<Text>{message}</Text>
			</Box>

			{detail && (
				<Box marginBottom={1}>
					<Text dimColor>{detail}</Text>
				</Box>
			)}

			<Box>
				<Text dimColor>
					Press <Text color="green">y</Text> or <Text color="green">Enter</Text>{' '}
					to confirm, <Text color="yellow">n</Text> or{' '}
					<Text color="yellow">Esc</Text> to cancel
				</Text>
			</Box>
		</Box>
	);
}
