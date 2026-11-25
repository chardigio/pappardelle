import {test, expect} from 'bun:test';
import {filterSpaces, searchKeyStep, type RailSearch} from './rail-search.ts';
import {press} from '../test/helpers/key-press.ts';
import type {SpaceData} from './types.ts';

function makeSpace(name: string, opts?: Partial<SpaceData>): SpaceData {
	return {name, worktreePath: `/worktrees/${name}`, ...opts};
}

function titled(name: string, title: string): SpaceData {
	return makeSpace(name, {
		linearIssue: {
			identifier: name,
			title,
			state: {name: 'Todo', color: '#ccc'},
		},
	});
}

function names(spaces: SpaceData[]): string[] {
	return spaces.map(space => space.name);
}

const searchable = [
	titled('STA-10', 'Dashboard redesign'),
	titled('STA-20', 'Fix STA-10 login regression'),
	titled('STA-30', 'Add rail search'),
	makeSpace('main', {isMainWorktree: true}),
];

test('an empty or blank query keeps every row', () => {
	expect(filterSpaces(searchable, '')).toStrictEqual(searchable);
	expect(filterSpaces(searchable, '  ')).toStrictEqual(searchable);
});

test('a query matches the key or the title in any case', () => {
	expect(names(filterSpaces(searchable, 'sta-10'))).toStrictEqual([
		'STA-10',
		'STA-20',
	]);
	expect(names(filterSpaces(searchable, 'SEARCH'))).toStrictEqual(['STA-30']);
	expect(names(filterSpaces(searchable, 'mai'))).toStrictEqual(['main']);
});

test('the query is matched the way the popup pickers match theirs', () => {
	expect(names(filterSpaces(searchable, 'fx lgn'))).toStrictEqual(['STA-20']);
	expect(names(filterSpaces(searchable, 'regression fix'))).toStrictEqual([]);
});

test('the tightest match comes first, whichever row it is', () => {
	const rows = [
		titled('STA-1', 'Rework the daily email'),
		titled('STA-2', 'Rail search'),
	];
	expect(names(filterSpaces(rows, 'rail'))).toStrictEqual(['STA-2', 'STA-1']);
});

test('a key typed in full comes ahead of longer keys that start with it', () => {
	const rows = [makeSpace('STA-19'), makeSpace('STA-10'), makeSpace('STA-1')];
	expect(names(filterSpaces(rows, 'sta-1'))).toStrictEqual([
		'STA-1',
		'STA-19',
		'STA-10',
	]);
});

function step(search: RailSearch, name: string, rows = searchable) {
	return searchKeyStep(search, rows, press(name), true);
}

test('Enter selects the highlighted match and closes the search', () => {
	expect(step({query: 'sta-10', index: 1}, 'return')).toStrictEqual({
		search: null,
		select: 'STA-20',
	});
});

test('Enter with no match closes the search and selects nothing', () => {
	expect(step({query: 'nothing', index: 0}, 'return')).toStrictEqual({
		search: null,
		select: undefined,
	});
});

test('Enter does not select a row that is still starting', () => {
	const rows = [makeSpace('STA-40', {isPending: true}), ...searchable];
	expect(step({query: 'sta', index: 0}, 'return', rows).select).toBe(undefined);
});

test('Enter selects the last match when rows left from under the highlight', () => {
	expect(
		step({query: 'sta', index: 2}, 'return', searchable.slice(0, 2)).select,
	).toBe('STA-20');
});

test('Escape closes the search without selecting', () => {
	expect(step({query: 'sta', index: 1}, 'escape')).toStrictEqual({
		search: null,
	});
});

test('the arrows move the highlight within the matches', () => {
	const search = {query: 'sta-10', index: 0};
	expect(step(search, 'up').search?.index).toBe(0);
	expect(step(search, 'down').search?.index).toBe(1);
	expect(step({...search, index: 1}, 'down').search?.index).toBe(1);
});

test('text typed before the input is drawn joins the query', () => {
	const typed = searchKeyStep(
		{query: 'st', index: 1},
		searchable,
		press('a'),
		false,
	);
	expect(typed.search).toStrictEqual({query: 'sta', index: 0});
});

test('Backspace before the input is drawn removes the last character', () => {
	const erased = searchKeyStep(
		{query: 'sta', index: 1},
		searchable,
		press('backspace'),
		false,
	);
	expect(erased.search).toStrictEqual({query: 'st', index: 0});
});

test('once the input is drawn, typed text is left to it', () => {
	const search = {query: 'st', index: 1};
	expect(step(search, 'a').search).toBe(search);
});
