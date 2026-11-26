import {test, expect} from 'bun:test';
import {
	buildRailRows,
	flatRailRows,
	nextSelectableRow,
	railRowHeight,
	railGroupOf,
	railGroupsFromConfig,
	resolveCursorRow,
	searchRailRows,
	splitAgentRows,
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
			: row.kind === 'pending'
				? `~ ${row.space.name}`
				: `  ${row.space.name}`,
	);
}

// ============================================================================
// railGroupOf
// ============================================================================

test('default groups put To Do, In Progress and unloaded issues in In Progress', () => {
	const group = (space: SpaceData) => railGroupOf(space, defaults)!.name;
	expect(group(issueSpace('STE-1', 'To Do', 'unstarted'))).toBe('In Progress');
	expect(group(issueSpace('STE-2', 'In Progress', 'started'))).toBe(
		'In Progress',
	);
	expect(group({name: 'STE-3', worktreePath: null})).toBe('In Progress');
});

test('default groups take In Review by name though Jira files it as started', () => {
	expect(
		railGroupOf(issueSpace('STE-1', 'In Review', 'started'), defaults)!.name,
	).toBe('In Review');
});

test('done covers Jira completed, Linear canceled and beads closed', () => {
	const group = (space: SpaceData) => railGroupOf(space, defaults)!.name;
	expect(group(issueSpace('STE-1', 'Done', 'completed'))).toBe('Done');
	expect(group(issueSpace('LIN-1', 'Canceled', 'canceled'))).toBe('Done');
	expect(group(issueSpace('bd-1', 'Closed', 'completed'))).toBe('Done');
});

test('main is always an agent space', () => {
	expect(railGroupOf(main, defaults)).toBe(null);
});

test('a listed status beats a category match', () => {
	const groups = railGroupsFromConfig([
		{name: 'Doing', color: 'blue', categories: ['todo', 'in_progress']},
		{name: 'Waiting', color: 'magenta', statuses: ['blocked', 'QA']},
		{name: 'Done', color: 'green', categories: ['done']},
	]);
	expect(
		railGroupOf(issueSpace('bd-1', 'Blocked', 'blocked'), groups)!.name,
	).toBe('Waiting');
	expect(railGroupOf(issueSpace('STE-1', 'qa', 'started'), groups)!.name).toBe(
		'Waiting',
	);
	expect(
		railGroupOf(issueSpace('bd-2', 'In Progress', 'in_progress'), groups)!.name,
	).toBe('Doing');
});

test('a status no group claims goes to the first group', () => {
	const groups = railGroupsFromConfig([
		{name: 'Review', color: 'magenta', statuses: ['In Review']},
		{name: 'Done', color: 'green', categories: ['done']},
	]);
	expect(
		railGroupOf(issueSpace('STE-1', 'In Progress', 'started'), groups)!.name,
	).toBe('Review');
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

test('groups follow config order and keep the incoming order inside a group', () => {
	expect(
		shape(
			buildRailRows({
				displaySpaces: spaces,
				groups: defaults,
			}),
		),
	).toStrictEqual([
		'  main',
		'# In Progress (2)',
		'  STE-20',
		'  STE-10',
		'# In Review (1)',
		'  STE-15',
		'# Done (1)',
		'  STE-5',
	]);
});

test('an issue moving into a group lands by number, not at the end', () => {
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
	expect(rows.slice(1, 5)).toStrictEqual([
		'# In Progress (3)',
		'  STE-20',
		'  STE-15',
		'  STE-10',
	]);
	expect(rows.includes('# In Review (0)')).toBe(false);
});

test('a starting session shows at the top of the first group and counts toward it', () => {
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
	expect(rows.slice(1, 3)).toStrictEqual(['# In Progress (3)', '~ STE-30']);
});

test('the narrow layout keeps the group order without headers', () => {
	expect(
		shape(
			buildRailRows({displaySpaces: spaces, groups: defaults, headers: false}),
		),
	).toStrictEqual(['  main', '  STE-20', '  STE-10', '  STE-15', '  STE-5']);
});

test('flat rows are the display list with pending rows marked', () => {
	const pending: SpaceData = {
		name: 'STE-30',
		worktreePath: null,
		isPending: true,
	};
	expect(shape(flatRailRows([main, pending, spaces[1]!]))).toStrictEqual([
		'  main',
		'~ STE-30',
		'  STE-20',
	]);
});

test('the workspace box takes the leading agent rows and the rail box the rest', () => {
	const rows = buildRailRows({displaySpaces: spaces, groups: defaults});
	const {agents, spaces: rest} = splitAgentRows(rows);
	expect(shape(agents)).toStrictEqual(['  main']);
	expect(shape(rest).slice(0, 2)).toStrictEqual([
		'# In Progress (2)',
		'  STE-20',
	]);
	expect(splitAgentRows(flatRailRows([main])).spaces).toStrictEqual([]);
	expect(splitAgentRows(flatRailRows([spaces[1]!])).agents).toStrictEqual([]);
});

// ============================================================================
// resolveCursorRow
// ============================================================================

test('the cursor sits on the selected space, or the first space before one is selected', () => {
	const rows = buildRailRows({displaySpaces: spaces, groups: defaults});
	expect(shape(rows)[resolveCursorRow(rows, spaces[2])]).toBe('  STE-15');
	expect(shape(rows)[resolveCursorRow(rows, undefined)]).toBe('  main');
	const workspacesOnly = buildRailRows({
		displaySpaces: spaces.slice(1),
		groups: defaults,
	});
	expect(
		shape(workspacesOnly)[resolveCursorRow(workspacesOnly, undefined)],
	).toBe('  STE-20');
});

// ============================================================================
// row helpers
// ============================================================================

test('j/k cross from the agents into the groups, skipping headers and pending rows and stop at either end', () => {
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
	// main, # In Progress, ~ STE-30, STE-20, STE-10, # In Review, ...
	expect(shape(rows)[nextSelectableRow(rows, 0, 1)]).toBe('  STE-20');
	expect(shape(rows)[nextSelectableRow(rows, at('  STE-20'), -1)]).toBe(
		'  main',
	);
	expect(shape(rows)[nextSelectableRow(rows, at('  STE-10'), 1)]).toBe(
		'  STE-15',
	);
	expect(shape(rows)[nextSelectableRow(rows, at('  STE-15'), -1)]).toBe(
		'  STE-10',
	);
	expect(nextSelectableRow(rows, 0, -1)).toBe(-1);
	expect(nextSelectableRow(rows, rows.length - 1, 1)).toBe(-1);
});

test('agent rows and headers are one line in a two-line rail', () => {
	const rows = buildRailRows({
		displaySpaces: spaces,
		groups: defaults,
	});
	expect(rows.map(row => railRowHeight(row, 2))).toStrictEqual([
		1, 1, 2, 2, 1, 2, 1, 2,
	]);
});

test('search results are one flat list of agents and spaces', () => {
	expect(shape(searchRailRows([main, spaces[1]!]))).toStrictEqual([
		'  main',
		'  STE-20',
	]);
});
