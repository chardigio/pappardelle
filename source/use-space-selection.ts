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
	// One input write can carry several keys (pasted or scripted sequences),
	// and their handlers all run before the next render. Each key must act on
	// the selection the previous one left, so `current()` is updated eagerly.
	const latest = useRef(state);
	const update = useCallback((next: (prev: Selection) => Selection) => {
		const value = next(latest.current);
		if (value === latest.current) return;
		latest.current = value;
		setState(value);
	}, []);
	const current = useCallback(() => latest.current, []);

	// Keep selection and rows in the same update so attachment effects never
	// observe another workspace at the old row index during a refresh.
	const setSpaces = useCallback(
		(change: SetStateAction<SpaceData[]>) => {
			update(prev => {
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
		},
		[update],
	);

	const setSelectedIndex = useCallback(
		(selectedIndex: number) => {
			update(prev =>
				prev.selectedIndex === selectedIndex ? prev : {...prev, selectedIndex},
			);
		},
		[update],
	);

	const selectSpace = useCallback(
		(name: string) => {
			update(prev => {
				const selectedIndex = findSpaceIndexByIssueKey(prev.spaces, name);
				return selectedIndex < 0 || selectedIndex === prev.selectedIndex
					? prev
					: {...prev, selectedIndex};
			});
		},
		[update],
	);

	return {...state, current, setSpaces, setSelectedIndex, selectSpace};
}
