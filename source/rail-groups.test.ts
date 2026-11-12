import test from 'ava';
import {
	buildRailRows,
	flatRailRows,
	nextSelectableRow,
	railRowHeight,
	railGroupOf,
	railGroupsFromConfig,
	resolveCursorRow,
	searchRailRows,
	type RailRow,
} from './rail-groups.ts';
import type {SpaceData} from './types.ts';

function issueSpace(
	name: string,
	stateName: string,
	stateType: string,
	extra: Partial<SpaceData> = {},
): SpaceData {
	return {
		name,
		worktreePath: null,
		trackerIssue: {
			identifier: name,
			title: name,
			state: {name: stateName, type: stateType, color: '#000000'},
		},
		...extra,
	};
}

const main: SpaceData = {
	name: 'main',
	worktreePath: '/r',
	isMainWorktree: true,
};
const defaults = railGroupsFromConfig();

function shape(rows: readonly RailRow[]): string[] {
	return rows.map(row =>
		row.kind === 'header'
			? `# ${row.group.name} (${row.count})`
			: row.kind === 'divider'
				? '---'
				: row.kind === 'pending'
					? `~ ${row.space.name}`
					: `  ${row.space.name}`,
	);
}

// ============================================================================
// railGroupOf
// ============================================================================

test('default groups put To Do, In Progress and unloaded issues in In Progress', t => {
	const group = (space: SpaceData) => railGroupOf(space, defaults).name;
	t.is(group(issueSpace('STE-1', 'To Do', 'unstarted')), 'In Progress');
	t.is(group(issueSpace('STE-2', 'In Progress', 'started')), 'In Progress');
	t.is(group({name: 'STE-3', worktreePath: null}), 'In Progress');
});

test('default groups take In Review by name though Jira files it as started', t => {
	t.is(
		railGroupOf(issueSpace('STE-1', 'In Review', 'started'), defaults).name,
		'In Review',
	);
});

test('done covers Jira completed, Linear canceled and beads closed', t => {
	const group = (space: SpaceData) => railGroupOf(space, defaults).name;
	t.is(group(issueSpace('STE-1', 'Done', 'completed')), 'Done');
	t.is(group(issueSpace('LIN-1', 'Canceled', 'canceled')), 'Done');
	t.is(group(issueSpace('bd-1', 'Closed', 'completed')), 'Done');
});

test('main is always an agent space', t => {
	t.is(railGroupOf(main, defaults), null);
});

test('a listed status beats a category match', t => {
	const groups = railGroupsFromConfig([
		{name: 'Doing', color: 'blue', categories: ['todo', 'in_progress']},
		{name: 'Waiting', color: 'magenta', statuses: ['blocked', 'QA']},
		{name: 'Done', color: 'green', categories: ['done']},
	]);
	t.is(
		railGroupOf(issueSpace('bd-1', 'Blocked', 'blocked'), groups).name,
		'Waiting',
	);
	t.is(
		railGroupOf(issueSpace('STE-1', 'qa', 'started'), groups).name,
		'Waiting',
	);
	t.is(
		railGroupOf(issueSpace('bd-2', 'In Progress', 'in_progress'), groups).name,
		'Doing',
	);
});

test('a status no group claims goes to the first group', t => {
	const groups = railGroupsFromConfig([
		{name: 'Review', color: 'magenta', statuses: ['In Review']},
		{name: 'Done', color: 'green', categories: ['done']},
	]);
	t.is(
		railGroupOf(issueSpace('STE-1', 'In Progress', 'started'), groups).name,
		'Review',
	);
});

// ============================================================================
// buildRailRows
// ============================================================================

const spaces = [
	main,
	issueSpace('STE-20', 'In Progress', 'started'),
	issueSpace('STE-15', 'In Review', 'started'),
	issueSpace('STE-10', 'To Do', 'unstarted'),
	issueSpace('STE-5', 'Done', 'completed'),
];

test('groups follow config order and keep the incoming order inside a group', t => {
	t.deepEqual(
		shape(
			buildRailRows({
				displaySpaces: spaces,
				groups: defaults,
			}),
		),
		[
			'  main',
			'---',
			'# In Progress (2)',
			'  STE-20',
			'  STE-10',
			'# In Review (1)',
			'  STE-15',
			'# Done (1)',
			'  STE-5',
		],
	);
});

test('an issue moving into a group lands by number, not at the end', t => {
	const moved = spaces.map(space =>
		space.name === 'STE-15'
			? issueSpace('STE-15', 'In Progress', 'started')
			: space,
	);
	const rows = shape(
		buildRailRows({
			displaySpaces: moved,
			groups: defaults,
		}),
	);
	t.deepEqual(rows.slice(2, 6), [
		'# In Progress (3)',
		'  STE-20',
		'  STE-15',
		'  STE-10',
	]);
	t.false(rows.includes('# In Review (0)'));
});

test('a starting session shows at the top of the first group and counts toward it', t => {
	const pending: SpaceData = {
		name: 'STE-30',
		worktreePath: null,
		isPending: true,
	};
	const rows = shape(
		buildRailRows({
			displaySpaces: [main, pending, ...spaces.slice(1)],
			groups: defaults,
		}),
	);
	t.deepEqual(rows.slice(2, 4), ['# In Progress (3)', '~ STE-30']);
});

test('the narrow layout keeps the group order without headers', t => {
	t.deepEqual(
		shape(
			buildRailRows({displaySpaces: spaces, groups: defaults, headers: false}),
		),
		['  main', '---', '  STE-20', '  STE-10', '  STE-15', '  STE-5'],
	);
});

test('flat rows are the display list with pending rows marked', t => {
	const pending: SpaceData = {
		name: 'STE-30',
		worktreePath: null,
		isPending: true,
	};
	t.deepEqual(shape(flatRailRows([main, pending, spaces[1]!])), [
		'  main',
		'---',
		'~ STE-30',
		'  STE-20',
	]);
});

test('no divider without both agent spaces and workspaces', t => {
	t.deepEqual(shape(flatRailRows([main])), ['  main']);
	t.deepEqual(shape(flatRailRows([spaces[1]!])), ['  STE-20']);
	t.deepEqual(
		shape(
			buildRailRows({
				displaySpaces: [main],
				groups: defaults,
			}),
		),
		['  main'],
	);
});

// ============================================================================
// resolveCursorRow
// ============================================================================

test('the cursor sits on the selected space, or the first space before one is selected', t => {
	const rows = buildRailRows({displaySpaces: spaces, groups: defaults});
	t.is(shape(rows)[resolveCursorRow(rows, spaces[2])], '  STE-15');
	t.is(shape(rows)[resolveCursorRow(rows, undefined)], '  main');
	const workspacesOnly = buildRailRows({
		displaySpaces: spaces.slice(1),
		groups: defaults,
	});
	t.is(
		shape(workspacesOnly)[resolveCursorRow(workspacesOnly, undefined)],
		'  STE-20',
	);
});

// ============================================================================
// row helpers
// ============================================================================

test('j/k skip headers, the divider and pending rows and stop at either end', t => {
	const pending: SpaceData = {
		name: 'STE-30',
		worktreePath: null,
		isPending: true,
	};
	const rows = buildRailRows({
		displaySpaces: [main, pending, ...spaces.slice(1)],
		groups: defaults,
	});
	const at = (name: string) => shape(rows).indexOf(name);
	// main, divider, # In Progress, ~ STE-30, STE-20, STE-10, # In Review, ...
	t.is(shape(rows)[nextSelectableRow(rows, 0, 1)], '  STE-20');
	t.is(shape(rows)[nextSelectableRow(rows, at('  STE-20'), -1)], '  main');
	t.is(shape(rows)[nextSelectableRow(rows, at('  STE-10'), 1)], '  STE-15');
	t.is(shape(rows)[nextSelectableRow(rows, at('  STE-15'), -1)], '  STE-10');
	t.is(nextSelectableRow(rows, 0, -1), -1);
	t.is(nextSelectableRow(rows, rows.length - 1, 1), -1);
});

test('agent rows, headers and the divider are one line in a two-line rail', t => {
	const rows = buildRailRows({
		displaySpaces: spaces,
		groups: defaults,
	});
	t.deepEqual(
		rows.map(row => railRowHeight(row, 2)),
		[1, 1, 1, 2, 2, 1, 2, 1, 2],
	);
});

test('search results have no divider', t => {
	t.deepEqual(shape(searchRailRows([main, spaces[1]!])), [
		'  main',
		'  STE-20',
	]);
});
