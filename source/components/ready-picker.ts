export const INPUT_INDEX = -1;

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

export function hasHighlightedRow(selectedIndex: number): boolean {
	return selectedIndex >= 0;
}

export function canCloseHighlightedRow(
	canClose: boolean,
	selectedIndex: number,
): boolean {
	return canClose && hasHighlightedRow(selectedIndex);
}

export function selectionAfterRemoval(
	removedIndex: number,
	remaining: number,
): number {
	if (remaining <= 0) return INPUT_INDEX;
	if (removedIndex < 0) return INPUT_INDEX;
	return Math.min(removedIndex, remaining - 1);
}

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
