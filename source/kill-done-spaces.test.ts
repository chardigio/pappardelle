import test from 'ava';
import {
	buildKillDoneConfirmContent,
	findDoneSpaces,
	formatKillDoneResult,
	KILL_DONE_EMPTY_MESSAGE,
} from './kill-done-spaces.ts';
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
// findDoneSpaces
// ============================================================================

test('picks spaces whose tracker state.type is completed', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	t.deepEqual(
		findDoneSpaces(spaces).map(s => s.name),
		['STA-10'],
	);
});

test('picks spaces whose tracker state.type is canceled', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('unstarted', 'Todo')}),
	];
	t.deepEqual(
		findDoneSpaces(spaces).map(s => s.name),
		['STA-10'],
	);
});

test('falls back to the deprecated linearIssue field', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {linearIssue: makeIssue('completed', 'Done')}),
	];
	t.deepEqual(
		findDoneSpaces(spaces).map(s => s.name),
		['STA-10'],
	);
});

test('never picks the main worktree, even when its issue reads done', t => {
	const spaces: SpaceData[] = [
		makeSpace('master', {
			isMainWorktree: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	t.deepEqual(findDoneSpaces(spaces), []);
});

test('never picks a pending row', t => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {
			isPending: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	t.deepEqual(findDoneSpaces(spaces), []);
});

test('never picks a space with no issue attached', t => {
	t.deepEqual(findDoneSpaces([makeSpace('STA-10')]), []);
});

test('returns an empty array for an empty list', t => {
	t.deepEqual(findDoneSpaces([]), []);
});

test('preserves rail order across a mixed list', t => {
	const spaces: SpaceData[] = [
		makeSpace('master', {isMainWorktree: true}),
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
	];
	t.deepEqual(
		findDoneSpaces(spaces).map(s => s.name),
		['STA-10', 'STA-30'],
	);
});

// ============================================================================
// buildKillDoneConfirmContent
// ============================================================================

test('confirm content pluralizes a multi-space batch', t => {
	const content = buildKillDoneConfirmContent(3);
	t.is(content.title, 'Close Done Spaces');
	t.is(content.message, 'Close 3 done/canceled spaces?');
	t.is(content.detail, 'The worktrees and git branches will remain on disk.');
	t.is(content.processingMessage, 'Closing 3 spaces…');
});

test('confirm content uses the singular for one space', t => {
	const content = buildKillDoneConfirmContent(1);
	t.is(content.message, 'Close 1 done/canceled space?');
	t.is(content.processingMessage, 'Closing 1 space…');
});

// ============================================================================
// formatKillDoneResult
// ============================================================================

test('result message reports a fully successful batch', t => {
	t.is(formatKillDoneResult(3, 3), 'Closed 3 spaces');
});

test('result message uses the singular for one space', t => {
	t.is(formatKillDoneResult(1, 1), 'Closed 1 space');
});

test('result message names the shortfall on a partial failure', t => {
	t.is(formatKillDoneResult(2, 3), 'Closed 2 of 3 spaces (1 failed)');
});

test('result message reports a batch where nothing closed', t => {
	t.is(formatKillDoneResult(0, 2), 'Closed 0 of 2 spaces (2 failed)');
});

// ============================================================================
// Empty-case copy
// ============================================================================

test('exports the header copy for the empty case', t => {
	t.is(KILL_DONE_EMPTY_MESSAGE, 'No done or canceled spaces');
});
