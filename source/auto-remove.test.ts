import {test, expect} from 'bun:test';
import {
	AUTO_REMOVE_STATE_TYPES,
	findDoneSpaces,
	findSpacesToAutoRemove,
} from './auto-remove.ts';
import {mapJiraIssue} from './providers/jira-provider.ts';
import type {TrackerIssue} from './providers/types.ts';
import type {SpaceData} from './types.ts';

// ============================================================================
// Helpers
// ============================================================================

function makeIssue(stateType: string, stateName = stateType): TrackerIssue {
	return {
		identifier: 'STA-1',
		title: 'Test issue',
		state: {name: stateName, type: stateType, color: '#95a2b3'},
		project: null,
	};
}

function makeSpace(
	name: string,
	overrides: Partial<SpaceData> = {},
): SpaceData {
	return {
		name,
		worktreePath: `/tmp/${name}`,
		...overrides,
	};
}

// ============================================================================
// Regression: off-by-default
// ============================================================================

test('regression: off by default — returns no spaces when flag is false', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	expect(findSpacesToAutoRemove(spaces, false)).toStrictEqual([]);
});

test('regression: off by default — returns no spaces when flag is undefined', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
	];
	expect(findSpacesToAutoRemove(spaces, undefined)).toStrictEqual([]);
});

// ============================================================================
// Enabled behavior
// ============================================================================

test('returns spaces whose tracker state.type is "completed" when enabled', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('STA-10');
});

test('returns spaces whose tracker state.type is "canceled" when enabled', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('STA-10');
});

test('returns both completed and canceled in a single pass', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('started', 'In Progress')}),
		makeSpace('STA-40', {trackerIssue: makeIssue('backlog', 'Backlog')}),
	];
	const names = findSpacesToAutoRemove(spaces, true).map(s => s.name);
	expect(names.sort()).toStrictEqual(['STA-10', 'STA-20']);
});

test('ignores non-terminal state types (started, backlog, unstarted, triage)', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-1', {trackerIssue: makeIssue('triage', 'Triage')}),
		makeSpace('STA-2', {trackerIssue: makeIssue('backlog', 'Backlog')}),
		makeSpace('STA-3', {trackerIssue: makeIssue('unstarted', 'Todo')}),
		makeSpace('STA-4', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('never returns the main worktree even if it somehow has a done issue', () => {
	const spaces: SpaceData[] = [
		makeSpace('main', {
			isMainWorktree: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('never returns pending placeholder rows', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-99', {
			isPending: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('skips spaces without a tracker issue', () => {
	const spaces: SpaceData[] = [makeSpace('STA-10')];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('also accepts the legacy linearIssue field', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {linearIssue: makeIssue('completed', 'Done')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('STA-10');
});

test('AUTO_REMOVE_STATE_TYPES contains exactly completed and canceled', () => {
	expect([...AUTO_REMOVE_STATE_TYPES].sort()).toStrictEqual([
		'canceled',
		'completed',
	]);
});

// ============================================================================
// Cross-provider: Jira issues must reach the same predicate (STA-2139)
// ============================================================================

test('finds a Jira space whose status category is Done', () => {
	const jiraIssue = mapJiraIssue({
		key: 'CHEX-1',
		fields: {
			summary: 'Shipped it',
			status: {name: 'Done', statusCategory: {key: 'done', name: 'Done'}},
		},
	});
	const spaces: SpaceData[] = [makeSpace('CHEX-1', {trackerIssue: jiraIssue})];
	const result = findDoneSpaces(spaces);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('CHEX-1');
});

test('leaves a Jira space alone while its status category is In Progress', () => {
	const jiraIssue = mapJiraIssue({
		key: 'CHEX-2',
		fields: {
			summary: 'Still going',
			status: {
				name: 'In Progress',
				statusCategory: {key: 'indeterminate', name: 'In Progress'},
			},
		},
	});
	const spaces: SpaceData[] = [makeSpace('CHEX-2', {trackerIssue: jiraIssue})];
	expect(findDoneSpaces(spaces)).toStrictEqual([]);
});
