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
 * Filter spaces by a search query, matching against issue key and title.
 *
 * Returns the filtered list and a mapping from filtered index → original index.
 * Pure function — no side effects, easy to test.
 */
export function filterSpaces(
	spaces: SpaceData[],
	query: string,
): {filtered: SpaceData[]; indexMap: number[]} {
	if (!query) {
		return {
			filtered: spaces,
			indexMap: spaces.map((_, i) => i),
		};
	}
	const q = query.toLowerCase();
	const filtered: SpaceData[] = [];
	const indexMap: number[] = [];
	for (let i = 0; i < spaces.length; i++) {
		const space = spaces[i]!;
		const nameMatch = space.name.toLowerCase().includes(q);
		const titleMatch = space.linearIssue?.title?.toLowerCase().includes(q);
		if (nameMatch || titleMatch) {
			filtered.push(space);
			indexMap.push(i);
		}
	}
	return {filtered, indexMap};
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
