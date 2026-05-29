import test from 'ava';
import {
	AUTO_REMOVE_STATE_TYPES,
	findSpacesToAutoRemove,
} from './auto-remove.ts';
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

test('regression: off by default — returns no spaces when flag is false', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	t.deepEqual(findSpacesToAutoRemove(spaces, false), []);
});

test('regression: off by default — returns no spaces when flag is undefined', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
	];
	t.deepEqual(findSpacesToAutoRemove(spaces, undefined), []);
});

// ============================================================================
// Enabled behavior
// ============================================================================

test('returns spaces whose tracker state.type is "completed" when enabled', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	t.is(result.length, 1);
	t.is(result[0]!.name, 'STA-10');
});

test('returns spaces whose tracker state.type is "canceled" when enabled', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	t.is(result.length, 1);
	t.is(result[0]!.name, 'STA-10');
});

test('returns both completed and canceled in a single pass', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('started', 'In Progress')}),
		makeSpace('STA-40', {trackerIssue: makeIssue('backlog', 'Backlog')}),
	];
	const names = findSpacesToAutoRemove(spaces, true).map(s => s.name);
	t.deepEqual(names.sort(), ['STA-10', 'STA-20']);
});

test('ignores non-terminal state types (started, backlog, unstarted, triage)', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-1', {trackerIssue: makeIssue('triage', 'Triage')}),
		makeSpace('STA-2', {trackerIssue: makeIssue('backlog', 'Backlog')}),
		makeSpace('STA-3', {trackerIssue: makeIssue('unstarted', 'Todo')}),
		makeSpace('STA-4', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	t.deepEqual(findSpacesToAutoRemove(spaces, true), []);
});

test('never returns the main worktree even if it somehow has a done issue', t => {
	const spaces: SpaceData[] = [
		makeSpace('main', {
			isMainWorktree: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	t.deepEqual(findSpacesToAutoRemove(spaces, true), []);
});

test('never returns pending placeholder rows', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-99', {
			isPending: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	t.deepEqual(findSpacesToAutoRemove(spaces, true), []);
});

test('skips spaces without a tracker issue', t => {
	const spaces: SpaceData[] = [makeSpace('STA-10')];
	t.deepEqual(findSpacesToAutoRemove(spaces, true), []);
});

test('also accepts the legacy linearIssue field', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {linearIssue: makeIssue('completed', 'Done')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	t.is(result.length, 1);
	t.is(result[0]!.name, 'STA-10');
});

test('AUTO_REMOVE_STATE_TYPES contains exactly completed and canceled', t => {
	t.deepEqual([...AUTO_REMOVE_STATE_TYPES].sort(), ['canceled', 'completed']);
});
