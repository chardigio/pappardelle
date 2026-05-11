import React, {useState, useEffect} from 'react';
import {Text, useInput} from 'ink';
import chalk from 'chalk';
import {handleTextInputKey} from './text-input-key.ts';

type Props = {
	value: string;
	onChange: (value: string) => void;
	onSubmit?: (value: string) => void;
	placeholder?: string;
	isFocused?: boolean;
	isShowingCursor?: boolean;
};

/**
 * Custom TextInput component based on ink-text-input with added support for:
 * - Alt+Left/Right: move cursor by word boundary
 * - Alt+Backspace: delete previous word
 * - fn+Delete: forward delete (Mac-native)
 *
 * All keypress logic lives in `handleTextInputKey` so it can be unit-tested
 * without rendering React.
 */
export default function TextInput({
	value: originalValue,
	placeholder = '',
	isFocused = true,
	isShowingCursor = true,
	onChange,
	onSubmit,
}: Props) {
	const [cursorOffset, setCursorOffset] = useState(
		(originalValue || '').length,
	);

	useEffect(() => {
		setCursorOffset(prev => {
			if (!isFocused || !isShowingCursor) {
				return prev;
			}

			const newValue = originalValue || '';
			if (prev > newValue.length - 1) {
				return newValue.length;
			}

			return prev;
		});
	}, [originalValue, isFocused, isShowingCursor]);

	const value = originalValue;
	let renderedValue = value;
	let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

	if (isShowingCursor && isFocused) {
		renderedPlaceholder =
			placeholder.length > 0
				? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
				: chalk.inverse(' ');
		renderedValue = value.length > 0 ? '' : chalk.inverse(' ');

		let i = 0;
		for (const char of value) {
			renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
			i++;
		}

		if (value.length > 0 && cursorOffset === value.length) {
			renderedValue += chalk.inverse(' ');
		}
	}

	useInput(
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
