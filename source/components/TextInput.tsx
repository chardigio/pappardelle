import React, {useState, useEffect, useRef} from 'react';
import {Text} from 'ink';
import chalk from 'chalk';
import {handleTextInputKey} from './text-input-key.ts';
import {reconcileCursorOffset} from './cursor-reconcile.ts';
import {useRawInput} from './use-raw-input.ts';

/**
 * Foreground colors a caller can ask for. A closed set rather than a free
 * string so the lookup stays typed, and so the palette is visible from here.
 */
const HIGHLIGHT_COLORS = {
	cyan: chalk.cyan,
	green: chalk.green,
	magenta: chalk.magenta,
} as const;

export type InputHighlight = {
	/** Characters from the start of the value to paint. */
	length: number;
	color: keyof typeof HIGHLIGHT_COLORS;
};

type Props = {
	value: string;
	onChange: (value: string) => void;
	onSubmit?: (value: string) => void;
	placeholder?: string;
	isFocused?: boolean;
	isShowingCursor?: boolean;
	/**
	 * Paint a run at the head of the value. The input itself has no opinion on
	 * what that run means; the parent measures it. Composes with the cursor,
	 * which keeps its inverse block wherever it lands.
	 */
	highlight?: InputHighlight;
};

/**
 * Custom TextInput component based on ink-text-input with added support for:
 * - Alt+Left/Right: move cursor by word boundary
 * - Alt+Backspace: delete previous word
 * - fn+Delete: forward delete (Mac-native)
 *
 * Uses `useRawInput` instead of Ink's `useInput` because Ink 4.x conflates the
 * Mac Delete/Backspace key (`\x7f`) and fn+Delete (`\x1b[3~`) under one
 * `'delete'` name — which silently broke regular delete after the forward-
 * delete feature landed in STA-1131 (see STA-1145). Parsing raw stdin
 * ourselves restores the distinction.
 *
 * All keypress logic lives in `handleTextInputKey` so it can be unit-tested
 * without rendering React.
 */
export default function TextInput({
	value: originalValue,
	placeholder = '',
	isFocused = true,
	isShowingCursor = true,
	highlight,
	onChange,
	onSubmit,
}: Props) {
	const [cursorOffset, setCursorOffset] = useState(
		(originalValue || '').length,
	);

	// The last value this input emitted, so a parent-driven replacement can be
	// told apart from the parent echoing back our own keystroke. See
	// `reconcileCursorOffset`.
	const lastEmittedRef = useRef(originalValue || '');

	useEffect(() => {
		setCursorOffset(prev => {
			if (!isFocused || !isShowingCursor) {
				return prev;
			}

			const next = reconcileCursorOffset({
				incomingValue: originalValue || '',
				lastEmittedValue: lastEmittedRef.current,
				cursorOffset: prev,
			});
			lastEmittedRef.current = originalValue || '';
			return next;
		});
	}, [originalValue, isFocused, isShowingCursor]);

	const value = originalValue;
	const paint = (char: string, index: number): string =>
		highlight && index < highlight.length
			? HIGHLIGHT_COLORS[highlight.color](char)
			: char;

	let renderedValue =
		highlight && highlight.length > 0
			? HIGHLIGHT_COLORS[highlight.color](value.slice(0, highlight.length)) +
				value.slice(highlight.length)
			: value;
	let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

	if (isShowingCursor && isFocused) {
		renderedPlaceholder =
			placeholder.length > 0
				? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
				: chalk.inverse(' ');
		renderedValue = value.length > 0 ? '' : chalk.inverse(' ');

		let i = 0;
		for (const char of value) {
			const painted = paint(char, i);
			renderedValue += i === cursorOffset ? chalk.inverse(painted) : painted;
			i++;
		}

		if (value.length > 0 && cursorOffset === value.length) {
			renderedValue += chalk.inverse(' ');
		}
	}

	useRawInput(
		(input, key) => {
			const result = handleTextInputKey(
				originalValue,
				cursorOffset,
				input,
				key,
			);

			if (result.ignored) {
				return;
			}

			if (result.submit) {
				if (onSubmit) {
					onSubmit(originalValue);
				}
				return;
			}

			// Cursor-only operations skip when cursor is hidden, matching the
			// previous behavior where arrow keys were no-ops without a cursor.
			const cursorMoved = result.cursorOffset !== cursorOffset;
			const valueChanged = result.value !== originalValue;
			if (cursorMoved && !valueChanged && !isShowingCursor) {
				return;
			}

			setCursorOffset(result.cursorOffset);
			if (valueChanged) {
				lastEmittedRef.current = result.value;
				onChange(result.value);
			}
		},
		{isActive: isFocused},
	);

	return (
		<Text>
			{placeholder
				? value.length > 0
					? renderedValue
					: renderedPlaceholder
				: renderedValue}
		</Text>
	);
}
