import {
	findPreviousWordBoundary,
	findNextWordBoundary,
	deleteWordBackward,
} from '../word-boundary.ts';

export type KeyLike = {
	leftArrow?: boolean;
	rightArrow?: boolean;
	upArrow?: boolean;
	downArrow?: boolean;
	backspace?: boolean;
	delete?: boolean;
	meta?: boolean;
	ctrl?: boolean;
	shift?: boolean;
	tab?: boolean;
	return?: boolean;
};

export type KeyResult = {
	value: string;
	cursorOffset: number;
	submit: boolean;
	ignored: boolean;
};

/**
 * Pure function that maps a single Ink keypress to a (value, cursorOffset)
 * mutation. Extracted from TextInput.tsx so the keymap can be unit-tested
 * without rendering React.
 *
 * Word-navigation handles three terminal conventions for Alt+Arrow:
 *   1. `\x1b\x1b[D` — Esc-prefix Option (parsed as leftArrow + meta)
 *   2. `\x1b[1;3D` — xterm CSI with Alt modifier (parsed as leftArrow + meta)
 *   3. `\x1bb` / `\x1bf` — readline word-movement convention used by macOS
 *      Terminal (Option-as-Meta) and iTerm2/Ghostty "Natural Text Editing"
 *      presets. Parsed by Ink as meta + input='b'/'f' with leftArrow=false.
 * The third convention is what most macOS users hit by default.
 */
export function handleTextInputKey(
	value: string,
	cursorOffset: number,
	input: string,
	key: KeyLike,
): KeyResult {
	if (
		key.upArrow ||
		key.downArrow ||
		(key.ctrl && input === 'c') ||
		key.tab ||
		(key.shift && key.tab)
	) {
		return {value, cursorOffset, submit: false, ignored: true};
	}

	if (key.return) {
		return {value, cursorOffset, submit: true, ignored: false};
	}

	const isAltLeft = key.meta && (key.leftArrow || input === 'b');
	const isAltRight = key.meta && (key.rightArrow || input === 'f');

	if (isAltLeft) {
		return {
			value,
			cursorOffset: findPreviousWordBoundary(value, cursorOffset),
			submit: false,
			ignored: false,
		};
	}

	if (isAltRight) {
		return {
			value,
			cursorOffset: findNextWordBoundary(value, cursorOffset),
			submit: false,
			ignored: false,
		};
	}

	if (key.leftArrow) {
		return {
			value,
			cursorOffset: Math.max(0, cursorOffset - 1),
			submit: false,
			ignored: false,
		};
	}

	if (key.rightArrow) {
		return {
			value,
			cursorOffset: Math.min(value.length, cursorOffset + 1),
			submit: false,
			ignored: false,
		};
	}

	if (key.backspace || key.delete) {
		if (cursorOffset === 0) {
			return {value, cursorOffset, submit: false, ignored: false};
		}
		if (key.meta) {
			const result = deleteWordBackward(value, cursorOffset);
			return {
				value: result.value,
				cursorOffset: result.cursorOffset,
				submit: false,
				ignored: false,
			};
		}
		return {
			value: value.slice(0, cursorOffset - 1) + value.slice(cursorOffset),
			cursorOffset: cursorOffset - 1,
			submit: false,
			ignored: false,
		};
	}

	const nextValue =
		value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
	const nextCursor = Math.min(nextValue.length, cursorOffset + input.length);
	return {
		value: nextValue,
		cursorOffset: nextCursor,
		submit: false,
		ignored: false,
	};
}
