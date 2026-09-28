import {useCallback, useState, type SetStateAction} from 'react';
import {findSpaceIndexByIssueKey} from './highlight.ts';
import type {SpaceData} from './types.ts';

export function useSpaceSelection() {
	const [state, setState] = useState<{
		spaces: SpaceData[];
		selectedIndex: number;
	}>({spaces: [], selectedIndex: 0});

	// Keep selection and rows in the same update so attachment effects never
	// observe another workspace at the old row index during a refresh.
	const setSpaces = useCallback((update: SetStateAction<SpaceData[]>) => {
		setState(prev => {
			const spaces =
				typeof update === 'function' ? update(prev.spaces) : update;
			if (spaces === prev.spaces) return prev;
			const selectedName = prev.spaces[prev.selectedIndex]?.name;
			const preservedIndex = spaces.findIndex(
				space => space.name === selectedName,
			);
			const selectedIndex =
				preservedIndex !== -1
					? preservedIndex
					: Math.max(0, Math.min(prev.selectedIndex, spaces.length - 1));
			return {spaces, selectedIndex};
		});
	}, []);

	const setSelectedIndex = useCallback((selectedIndex: number) => {
		setState(prev =>
			prev.selectedIndex === selectedIndex ? prev : {...prev, selectedIndex},
		);
	}, []);

	const selectSpace = useCallback((name: string) => {
		setState(prev => {
			const selectedIndex = findSpaceIndexByIssueKey(prev.spaces, name);
			return selectedIndex < 0 || selectedIndex === prev.selectedIndex
				? prev
				: {...prev, selectedIndex};
		});
	}, []);

	return {...state, setSpaces, setSelectedIndex, selectSpace};
}
