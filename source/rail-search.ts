import type {shortcutKey} from './tui-key.ts';
import type {SpaceData} from './types.ts';

/** The rail's search: what was typed and which match is highlighted. */
export type RailSearch = {query: string; index: number};

/**
 * The rows whose key or title contains every word of the query, in any order
 * and any case.
 */
export function filterSpaces(spaces: SpaceData[], query: string): SpaceData[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return spaces;
	return spaces.filter(space => {
		const text =
			`${space.name} ${space.linearIssue?.title ?? ''}`.toLowerCase();
		return words.every(word => text.includes(word));
	});
}

/** A refresh can remove rows from under the highlight. */
export function highlightedIndex(
	search: RailSearch,
	matchCount: number,
): number {
	return Math.max(0, Math.min(search.index, matchCount - 1));
}

/**
 * What one key does to an open search: the search afterwards (null once it
 * closes) and the workspace to select, if any.
 *
 * The search row's input takes typed text once it is drawn. Keys that arrive
 * in the same input write as the `/` that opened the search come before that,
 * so their text is added here.
 */
export function searchKeyStep(
	search: RailSearch,
	rows: SpaceData[],
	{input, key}: ReturnType<typeof shortcutKey>,
	inputDrawn: boolean,
): {search: RailSearch | null; select?: string} {
	const matches = filterSpaces(rows, search.query);
	const index = highlightedIndex(search, matches.length);
	if (key.escape) return {search: null};
	if (key.return) {
		const choice = matches[index];
		return {
			search: null,
			select: choice && !choice.isPending ? choice.name : undefined,
		};
	}

	if (key.upArrow || (input === 'k' && key.ctrl))
		return {search: {...search, index: Math.max(0, index - 1)}};
	if (key.downArrow || (input === 'j' && key.ctrl)) {
		return {
			search: {
				...search,
				index: highlightedIndex({...search, index: index + 1}, matches.length),
			},
		};
	}

	if (!inputDrawn && input && !key.ctrl && !key.meta)
		return {search: {query: search.query + input, index: 0}};
	return {search};
}
