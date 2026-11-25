import {test, expect} from 'bun:test';
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

test('picks spaces whose tracker state.type is completed', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	expect(findDoneSpaces(spaces).map(s => s.name)).toStrictEqual(['STA-10']);
});

test('picks spaces whose tracker state.type is canceled', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('unstarted', 'Todo')}),
	];
	expect(findDoneSpaces(spaces).map(s => s.name)).toStrictEqual(['STA-10']);
});

test('falls back to the deprecated linearIssue field', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {linearIssue: makeIssue('completed', 'Done')}),
	];
	expect(findDoneSpaces(spaces).map(s => s.name)).toStrictEqual(['STA-10']);
});

test('never picks the main worktree, even when its issue reads done', () => {
	const spaces: SpaceData[] = [
		makeSpace('master', {
			isMainWorktree: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	expect(findDoneSpaces(spaces)).toStrictEqual([]);
});

test('never picks a pending row', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {
			isPending: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	expect(findDoneSpaces(spaces)).toStrictEqual([]);
});

test('never picks a space with no issue attached', () => {
	expect(findDoneSpaces([makeSpace('STA-10')])).toStrictEqual([]);
});

test('returns an empty array for an empty list', () => {
	expect(findDoneSpaces([])).toStrictEqual([]);
});

test('preserves rail order across a mixed list', () => {
	const spaces: SpaceData[] = [
		makeSpace('master', {isMainWorktree: true}),
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
	];
	expect(findDoneSpaces(spaces).map(s => s.name)).toStrictEqual([
		'STA-10',
		'STA-30',
	]);
});

// ============================================================================
// buildKillDoneConfirmContent
// ============================================================================

test('confirm content pluralizes a multi-space batch', () => {
	const content = buildKillDoneConfirmContent(3);
	expect(content.title).toBe('Close Done Spaces');
	expect(content.message).toBe('Close 3 done/canceled spaces?');
	expect(content.detail).toBe(
		'The worktrees and git branches will remain on disk.',
	);
	expect(content.processingMessage).toBe('Closing 3 spaces…');
});

test('confirm content uses the singular for one space', () => {
	const content = buildKillDoneConfirmContent(1);
	expect(content.message).toBe('Close 1 done/canceled space?');
	expect(content.processingMessage).toBe('Closing 1 space…');
});

// ============================================================================
// formatKillDoneResult
// ============================================================================

test('result message reports a fully successful batch', () => {
	expect(formatKillDoneResult(3, 3)).toBe('Closed 3 spaces');
});

test('result message uses the singular for one space', () => {
	expect(formatKillDoneResult(1, 1)).toBe('Closed 1 space');
});

test('result message names the shortfall on a partial failure', () => {
	expect(formatKillDoneResult(2, 3)).toBe('Closed 2 of 3 spaces (1 failed)');
});

test('result message reports a batch where nothing closed', () => {
	expect(formatKillDoneResult(0, 2)).toBe('Closed 0 of 2 spaces (2 failed)');
});

// ============================================================================
// Empty-case copy
// ============================================================================

test('exports the header copy for the empty case', () => {
	expect(KILL_DONE_EMPTY_MESSAGE).toBe('No done or canceled spaces');
});
