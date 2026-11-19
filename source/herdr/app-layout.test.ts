import test from 'ava';
import {
	adoptionLabels,
	findSpace,
	findTerminalIn,
	findTerminalTab,
	paneIdsOfTab,
	spaceHasPanes,
} from './app-layout.ts';
import type {AppSpace} from './app.ts';

// A window shaped like the real one: spaces hold tabs, and a tab holds panes,
// each pane being a terminal.
const space = (
	id: string,
	name: string,
	tabs: Array<{id: string; terminals: Array<[string, string]>}>,
): AppSpace => ({
	id,
	name,
	folder: null,
	machine: null,
	active: false,
	tabs: tabs.map(tab => ({
		id: tab.id,
		name: tab.id,
		active: false,
		settled: false,
		terminals: tab.terminals.map(([terminal, pane]) => ({
			terminal,
			pane,
			status: null,
			app: null,
			name: null,
		})),
	})),
});

const SPACES: AppSpace[] = [
	space('spA', 'repo', [
		{id: 'tbRail', terminals: [['t1', 'p1']]},
		{
			id: 'tbSTA-1',
			terminals: [
				['t2', 'p2'],
				['t3', 'p3'],
			],
		},
	]),
	space('spB', 'other', [{id: 'tbB', terminals: [['t9', 'p9']]}]),
];

test('findTerminalIn locates a terminal by its address', t => {
	t.deepEqual(findTerminalIn(SPACES, 't3'), {
		spaceId: 'spA',
		tabId: 'tbSTA-1',
		paneId: 'p3',
	});
	t.deepEqual(findTerminalIn(SPACES, 't9'), {
		spaceId: 'spB',
		tabId: 'tbB',
		paneId: 'p9',
	});
});

test('findTerminalIn returns null for a terminal the window does not show', t => {
	t.is(findTerminalIn(SPACES, 't404'), null);
	t.is(findTerminalIn([], 't1'), null);
});

test('findSpace finds a space by id', t => {
	t.is(findSpace(SPACES, 'spB')?.name, 'other');
	t.is(findSpace(SPACES, 'spZ'), undefined);
});

test('findTerminalTab returns the space and tab around a terminal', t => {
	const found = findTerminalTab(SPACES, 't2');
	t.is(found?.space.id, 'spA');
	t.is(found?.tab.id, 'tbSTA-1');
	t.is(findTerminalTab(SPACES, 'nope'), null);
});

test('paneIdsOfTab lists a tab panes in the window order', t => {
	t.deepEqual(paneIdsOfTab(SPACES, 't2'), ['p2', 'p3']);
	t.deepEqual(paneIdsOfTab(SPACES, 't1'), ['p1']);
	t.deepEqual(paneIdsOfTab(SPACES, 'nope'), []);
});

// Adoption is the whole integration: these two labels are what make the window
// show a core terminal as a pane.
test('adoptionLabels are the keys the window reads', t => {
	t.deepEqual(adoptionLabels('spA', 'tb1'), {
		'herdr.space': 'spA',
		'herdr.tab': 'tb1',
	});
});

test('spaceHasPanes tells a ready space from one with no tab', t => {
	t.true(spaceHasPanes(SPACES[0]));
	t.false(spaceHasPanes(undefined));
	t.false(spaceHasPanes(space('spC', 'empty', [])));
});
