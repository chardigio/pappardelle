/**
 * Word-boundary cursor navigation helpers for text input fields.
 * Mimics the Alt+Arrow / Option+Arrow behavior of standard text editors.
 */

function isWordChar(char: string): boolean {
	return /[\w]/.test(char);
}

/**
 * Find the cursor position after moving left by one word.
 * Skips any non-word characters (spaces/punctuation) first, then skips the word.
 */
export function findPreviousWordBoundary(
	text: string,
	cursorOffset: number,
): number {
	if (cursorOffset <= 0) return 0;

	let pos = cursorOffset;

	// Phase 1: skip non-word characters (spaces, punctuation) immediately before cursor
	while (pos > 0 && !isWordChar(text[pos - 1]!)) {
		pos--;
	}

	// Phase 2: skip word characters to reach the start of the word
	while (pos > 0 && isWordChar(text[pos - 1]!)) {
		pos--;
	}

	return pos;
}

/**
 * Find the cursor position after moving right by one word.
 * Skips non-word characters (spaces/punctuation) first, then skips the word,
 * landing at the end of the next word (readline-style).
 */
export function findNextWordBoundary(
	text: string,
	cursorOffset: number,
): number {
	const len = text.length;
	if (cursorOffset >= len) return len;

	let pos = cursorOffset;

	// Phase 1: skip non-word characters (spaces, punctuation)
	while (pos < len && !isWordChar(text[pos]!)) {
		pos++;
	}

	// Phase 2: skip word characters to reach the end of the word
	while (pos < len && isWordChar(text[pos]!)) {
		pos++;
	}

	return pos;
}

/**
 * Delete from the cursor position back to the previous word boundary.
 * Returns the new value and cursor position.
 */
export function deleteWordBackward(
	text: string,
	cursorOffset: number,
): {value: string; cursorOffset: number} {
	if (cursorOffset <= 0) return {value: text, cursorOffset: 0};

	const newOffset = findPreviousWordBoundary(text, cursorOffset);
	const newValue = text.slice(0, newOffset) + text.slice(cursorOffset);

	return {value: newValue, cursorOffset: newOffset};
}
