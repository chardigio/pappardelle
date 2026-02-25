import type {SpaceData} from './types.ts';

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
