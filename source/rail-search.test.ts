import test from 'ava';
import {filterSpaces, searchKeyStep, type RailSearch} from './rail-search.ts';
import {shortcutKey} from './tui-key.ts';
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

test('an empty or blank query keeps every row', t => {
	t.deepEqual(filterSpaces(searchable, ''), searchable);
	t.deepEqual(filterSpaces(searchable, '  '), searchable);
});

test('a query matches the key or the title in any case', t => {
	t.deepEqual(names(filterSpaces(searchable, 'sta-10')), ['STA-10', 'STA-20']);
	t.deepEqual(names(filterSpaces(searchable, 'SEARCH')), ['STA-30']);
	t.deepEqual(names(filterSpaces(searchable, 'mai')), ['main']);
});

test('the query is matched the way the popup pickers match theirs', t => {
	t.deepEqual(names(filterSpaces(searchable, 'fx lgn')), ['STA-20']);
	t.deepEqual(names(filterSpaces(searchable, 'regression fix')), []);
});

test('the tightest match comes first, whichever row it is', t => {
	const rows = [
		titled('STA-1', 'Rework the daily email'),
		titled('STA-2', 'Rail search'),
	];
	t.deepEqual(names(filterSpaces(rows, 'rail')), ['STA-2', 'STA-1']);
});

test('a key typed in full comes ahead of longer keys that start with it', t => {
	const rows = [makeSpace('STA-19'), makeSpace('STA-10'), makeSpace('STA-1')];
	t.deepEqual(names(filterSpaces(rows, 'sta-1')), [
		'STA-1',
		'STA-19',
		'STA-10',
	]);
});

function press(name: string) {
	return shortcutKey({
		name,
		ctrl: false,
		meta: false,
		shift: false,
		option: false,
	} as Parameters<typeof shortcutKey>[0]);
}

function step(search: RailSearch, name: string, rows = searchable) {
	return searchKeyStep(search, rows, press(name), true);
}

test('Enter selects the highlighted match and closes the search', t => {
	t.deepEqual(step({query: 'sta-10', index: 1}, 'return'), {
		search: null,
		select: 'STA-20',
	});
});

test('Enter with no match closes the search and selects nothing', t => {
	t.deepEqual(step({query: 'nothing', index: 0}, 'return'), {
		search: null,
		select: undefined,
	});
});

test('Enter does not select a row that is still starting', t => {
	const rows = [makeSpace('STA-40', {isPending: true}), ...searchable];
	t.is(step({query: 'sta', index: 0}, 'return', rows).select, undefined);
});

test('Enter selects the last match when rows left from under the highlight', t => {
	t.is(
		step({query: 'sta', index: 2}, 'return', searchable.slice(0, 2)).select,
		'STA-20',
	);
});

test('Escape closes the search without selecting', t => {
	t.deepEqual(step({query: 'sta', index: 1}, 'escape'), {search: null});
});

test('the arrows move the highlight within the matches', t => {
	const search = {query: 'sta-10', index: 0};
	t.is(step(search, 'up').search?.index, 0);
	t.is(step(search, 'down').search?.index, 1);
	t.is(step({...search, index: 1}, 'down').search?.index, 1);
});

test('text typed before the input is drawn joins the query', t => {
	const typed = searchKeyStep(
		{query: 'st', index: 1},
		searchable,
		press('a'),
		false,
	);
	t.deepEqual(typed.search, {query: 'sta', index: 0});
});

test('Backspace before the input is drawn removes the last character', t => {
	const erased = searchKeyStep(
		{query: 'sta', index: 1},
		searchable,
		press('backspace'),
		false,
	);
	t.deepEqual(erased.search, {query: 'st', index: 0});
});

test('once the input is drawn, typed text is left to it', t => {
	const search = {query: 'st', index: 1};
	t.is(step(search, 'a').search, search);
});
