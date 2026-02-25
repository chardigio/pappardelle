import type {SpaceData} from './types.ts';

/**
 * Whether the space list item should show "Loading…" as its title.
 *
 * Returns true when the Linear issue title hasn't been fetched yet
 * for a real (non-pending, non-main-worktree) space with a name.
 */
export function shouldShowLoadingTitle(space: SpaceData): boolean {
	return (
		!space.pendingTitle &&
		!space.linearIssue?.title &&
		!space.isMainWorktree &&
		space.name.length > 0
	);
}

/**
 * Compute the new spaces array and selected index after deleting a space.
 *
 * Pure function — no side effects, easy to test.
 */
export function computePostDeleteState(
	spaces: SpaceData[],
	deletedName: string,
	selectedIndex: number,
): {filteredSpaces: SpaceData[]; newSelectedIndex: number} {
	const filteredSpaces = spaces.filter(s => s.name !== deletedName);
	const newSelectedIndex =
		selectedIndex >= filteredSpaces.length && selectedIndex > 0
			? selectedIndex - 1
			: selectedIndex;
	return {filteredSpaces, newSelectedIndex};
}
