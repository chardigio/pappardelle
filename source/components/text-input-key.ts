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
 *
 * Ctrl+A / Ctrl+E / Ctrl+U implement the readline line-editing shortcuts.
 * iTerm2's "Natural Text Editing" preset (and equivalents in other emulators)
 * translates Cmd+Left, Cmd+Right, and Cmd+Backspace to those same control
 * codes, so wiring them here transparently picks up the macOS Cmd shortcuts.
 *
 * fn+Delete on Mac (forward delete) sends `\x1b[3~`, which Ink parses as
 * key.delete=true with no meta. That's distinct from Alt+Backspace
 * (`\x1b\x7f`), which Ink parses as key.delete + key.meta — the meta branch
 * keeps doing word-back so Option+Backspace still kills the previous word.
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

	if (key.ctrl && input === 'a') {
		return {value, cursorOffset: 0, submit: false, ignored: false};
	}

	if (key.ctrl && input === 'e') {
		return {value, cursorOffset: value.length, submit: false, ignored: false};
	}

	if (key.ctrl && input === 'u') {
		return {
			value: value.slice(cursorOffset),
			cursorOffset: 0,
			submit: false,
			ignored: false,
		};
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

	// Plain key.delete (fn+Delete on Mac, `\x1b[3~`) is forward delete: drop the
	// char at the cursor, leave the cursor put. key.delete+meta is Alt+Backspace
	// on macOS with Option-as-Meta (`\x1b\x7f`), which is word-back — so the
	// meta branch falls through to the backspace handler below.
	if (key.delete && !key.meta) {
		if (cursorOffset >= value.length) {
			return {value, cursorOffset, submit: false, ignored: false};
		}
		return {
			value: value.slice(0, cursorOffset) + value.slice(cursorOffset + 1),
			cursorOffset,
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
