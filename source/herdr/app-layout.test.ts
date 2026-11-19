import test from 'ava';
import {
	findSpace,
	findTerminalIn,
	panesOfTab,
	viewerPanesOf,
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

// The rail's tab holds all three panes: rail, agent viewer, companion viewer.
// A second tab exists to stand for a tab the person made themselves.
const SPACES: AppSpace[] = [
	space('spA', 'repo', [
		{
			id: 'tbRail',
			terminals: [
				['t1', 'p1'],
				['t8', 'p8'],
				['t9', 'p9'],
			],
		},
		{id: 'tbTheirs', terminals: [['t2', 'p2']]},
	]),
	space('spB', 'other', [{id: 'tbB', terminals: [['t7', 'p7']]}]),
];

test('findTerminalIn locates a terminal by its address', t => {
	t.deepEqual(findTerminalIn(SPACES, 't9'), {
		spaceId: 'spA',
		tabId: 'tbRail',
		paneId: 'p9',
	});
	t.deepEqual(findTerminalIn(SPACES, 't7'), {
		spaceId: 'spB',
		tabId: 'tbB',
		paneId: 'p7',
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

test('panesOfTab lists a tab pane in the window order', t => {
	t.deepEqual(panesOfTab(SPACES, 't1'), ['p1', 'p8', 'p9']);
	t.deepEqual(panesOfTab(SPACES, 't2'), ['p2']);
	t.deepEqual(panesOfTab(SPACES, 'nope'), []);
});

// The viewers are the panes beside the rail, in the order they were split:
// agent first, companion second. This order is what tells the layout which
// pane to show a space's agent in.
test('viewerPanesOf lists the tab panes beside the rail, in split order', t => {
	t.deepEqual(viewerPanesOf(SPACES, 't1'), ['p8', 'p9']);
});

test('viewerPanesOf is empty for a rail with no viewers yet', t => {
	t.deepEqual(viewerPanesOf(SPACES, 't2'), []);
	t.deepEqual(viewerPanesOf(SPACES, 't404'), []);
});

test('viewerPanesOf never names the rail', t => {
	t.false(viewerPanesOf(SPACES, 't1').includes('p1'));
});
