import test from 'ava';
import {
	findSpace,
	findTerminalIn,
	paneHoldingTerminal,
	panesOfTab,
	railColumnWidths,
	viewerPanesAmong,
} from './app-layout.ts';
import {VIEWER_ROLE_LABEL} from './terminals.ts';
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

// `paneHoldingTerminal` is how a labelled viewer terminal is turned back into
// the pane it is drawn in, which is what `terminal.show` needs.
test('paneHoldingTerminal finds the pane a terminal is drawn in', t => {
	t.deepEqual(paneHoldingTerminal(SPACES, 't1'), {
		spaceId: 'spA',
		tabId: 'tbRail',
		paneId: 'p1',
	});
	t.is(paneHoldingTerminal(SPACES, 't404'), null);
});

// The case the caller relies on: a labelled viewer the window is no longer
// drawing (its tab was closed) has no pane, so the layout makes a new one
// instead of showing into a pane that is gone.
test('paneHoldingTerminal is null for a viewer the window stopped showing', t => {
	t.is(paneHoldingTerminal(SPACES, 't-split-tab-closed'), null);
});

// The panes the layout may reuse are the ones it labelled. A pane the person
// split carries no such label, so it is never adopted -- that is the whole
// point of the label.
test('viewerPanesAmong returns the labelled viewers by role', t => {
	t.deepEqual(
		viewerPanesAmong(
			[
				{address: 't8', labels: {[VIEWER_ROLE_LABEL]: 'agent'}},
				{address: 't9', labels: {[VIEWER_ROLE_LABEL]: 'companion'}},
			],
			address => ({paneId: `p-${address}`}),
		),
		{agent: 'p-t8', companion: 'p-t9'},
	);
});

// Roles are independent: a space with only an agent viewer still lays out.
test('viewerPanesAmong leaves a missing role empty', t => {
	t.deepEqual(
		viewerPanesAmong(
			[{address: 't8', labels: {[VIEWER_ROLE_LABEL]: 'agent'}}],
			address => ({paneId: `p-${address}`}),
		),
		{agent: 'p-t8', companion: ''},
	);
	t.deepEqual(
		viewerPanesAmong([], () => ({paneId: 'p'})),
		{
			agent: '',
			companion: '',
		},
	);
});

// A labelled terminal that is no longer drawn in a pane cannot be shown into,
// so it counts as missing and the caller splits a fresh viewer.
test('viewerPanesAmong drops a viewer the window no longer shows', t => {
	t.deepEqual(
		viewerPanesAmong(
			[
				{address: 't8', labels: {[VIEWER_ROLE_LABEL]: 'agent'}},
				{address: 't9', labels: {[VIEWER_ROLE_LABEL]: 'companion'}},
			],
			address => (address === 't9' ? null : {paneId: 'p-t8'}),
		),
		{agent: 'p-t8', companion: ''},
	);
});

// The three columns are 1/4 : 1/2 : 1/4, which splits cannot express: a split
// halves its source, so three panes always come out {1/2, 1/4, 1/4}. The widths
// are asked for directly instead.
test('railColumnWidths puts the agent at twice the rail and companion', t => {
	const widths = railColumnWidths({
		listPaneId: 'pRail',
		agentViewerPaneId: 'pAgent',
		companionViewerPaneId: 'pComp',
	});
	const px = Object.fromEntries(widths.map(w => [w.paneId, w.px]));
	t.is(px['pAgent'], px['pRail']! * 2);
	t.is(px['pComp'], px['pRail']);
	t.deepEqual(
		widths.map(w => w.paneId),
		['pRail', 'pAgent', 'pComp'],
	);
});

// A space with no companion gets two columns; nothing is sent for a pane that
// does not exist.
test('railColumnWidths leaves out a missing companion', t => {
	const widths = railColumnWidths({
		listPaneId: 'pRail',
		agentViewerPaneId: 'pAgent',
		companionViewerPaneId: '',
	});
	t.deepEqual(
		widths.map(w => w.paneId),
		['pRail', 'pAgent'],
	);
});
