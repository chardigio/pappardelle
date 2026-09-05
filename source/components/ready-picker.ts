/**
 * Selection logic for the ready-work picker shown under the new-session
 * prompt. Kept free of React so the keymap can be unit-tested directly.
 *
 * The text input and the list share one selection cursor: INPUT_INDEX means
 * the caret is in the text field, and 0..count-1 point at a suggestion. That
 * union is what lets the input stay focused the whole time — arrow keys are
 * a no-op inside the field (handleTextInputKey ignores them), so the dialog
 * can claim them for list movement without stealing typing.
 */

export const INPUT_INDEX = -1;

/**
 * Move the shared cursor by one row. Deliberately does not wrap: the list is
 * anchored below a text field, so wrapping from the last suggestion back to
 * the input reads as a glitch rather than a shortcut.
 */
export function moveSelection(
	current: number,
	count: number,
	direction: 'up' | 'down',
): number {
	if (count <= 0) return INPUT_INDEX;

	const next = direction === 'down' ? current + 1 : current - 1;
	if (next < INPUT_INDEX) return INPUT_INDEX;
	if (next > count - 1) return count - 1;
	return next;
}

/**
 * What Enter should submit. A highlighted suggestion wins over whatever is in
 * the text field, so a user who typed a few characters and then arrowed into
 * the list gets the issue they are looking at.
 *
 * Returns null when there is nothing to submit — an empty field with no
 * selection — and the caller should ignore the keypress.
 */
export function resolveSubmission(
	typed: string,
	identifiers: readonly string[],
	selectedIndex: number,
): string | null {
	if (selectedIndex >= 0) {
		return identifiers[selectedIndex] ?? null;
	}

	const trimmed = typed.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether the cursor is on a suggestion rather than in the text field.
 *
 * Highlighting a suggestion moves the caret out of the field, and the field goes
 * inert while it is gone, so letters over the list are unambiguously commands:
 * typing a task that starts with one of them ("xcode crash on launch", "index
 * rebuild times out") means first returning to the field with ↑.
 */
export function hasHighlightedRow(selectedIndex: number): boolean {
	return selectedIndex >= 0;
}

/**
 * Whether the close keybinding is live. Additionally gated on the tracker being
 * able to close at all, which is not universal — unlike the open key, which
 * every tracker can serve one way or another.
 */
export function canCloseHighlightedRow(
	canClose: boolean,
	selectedIndex: number,
): boolean {
	return canClose && hasHighlightedRow(selectedIndex);
}

/**
 * Where the cursor lands after the highlighted row is removed from the list.
 * Staying on the same index keeps the user over the next piece of work, which
 * is what triage wants: closing three stale beads in a row costs three
 * close-and-confirm rounds, with no re-navigation between them.
 *
 * `removedIndex` is the row that went away and `remaining` the new count.
 */
export function selectionAfterRemoval(
	removedIndex: number,
	remaining: number,
): number {
	if (remaining <= 0) return INPUT_INDEX;
	if (removedIndex < 0) return INPUT_INDEX;
	return Math.min(removedIndex, remaining - 1);
}

/**
 * Which slice of the suggestions to render so the highlighted row stays on
 * screen. The dialog floats over the space list, so an unbounded list would
 * push the prompt off the top of short terminals.
 */
export function visibleWindow(
	selectedIndex: number,
	count: number,
	maxVisible: number,
): {start: number; end: number} {
	if (count <= maxVisible) return {start: 0, end: count};

	// A cursor in the text field shows the head of the list, not a window
	// scrolled to wherever the user last was.
	const anchor = Math.max(0, selectedIndex);
	const start = Math.min(
		Math.max(0, anchor - Math.floor(maxVisible / 2)),
		count - maxVisible,
	);
	return {start, end: start + maxVisible};
}
