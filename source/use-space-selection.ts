import {useCallback, useRef, useState, type SetStateAction} from 'react';
import {findSpaceIndexByIssueKey} from './highlight.ts';
import type {SpaceData} from './types.ts';

type Selection = {
	spaces: SpaceData[];
	selectedIndex: number;
};

export function useSpaceSelection() {
	const [state, setState] = useState<Selection>({
		spaces: [],
		selectedIndex: 0,
	});
	// For callbacks that outlive the render they were made in.
	const latest = useRef(state);
	latest.current = state;
	const current = useCallback(() => latest.current, []);

	// Keep selection and rows in the same update so attachment effects never
	// observe another workspace at the old row index during a refresh.
	const setSpaces = useCallback((change: SetStateAction<SpaceData[]>) => {
		setState(prev => {
			const spaces =
				typeof change === 'function' ? change(prev.spaces) : change;
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

	// Resolved against the rows the update lands on: a refresh can still be
	// queued, not yet drawn, when a key moves the selection.
	const moveSelection = useCallback((step: -1 | 1) => {
		setState(prev => {
			const selectedIndex = Math.max(
				0,
				Math.min(prev.selectedIndex + step, prev.spaces.length - 1),
			);
			return selectedIndex === prev.selectedIndex
				? prev
				: {...prev, selectedIndex};
		});
	}, []);

	const selectSpace = useCallback((name: string) => {
		setState(prev => {
			const selectedIndex = findSpaceIndexByIssueKey(prev.spaces, name);
			return selectedIndex < 0 || selectedIndex === prev.selectedIndex
				? prev
				: {...prev, selectedIndex};
		});
	}, []);

	return {
		...state,
		current,
		setSpaces,
		moveSelection,
		selectSpace,
	};
}
