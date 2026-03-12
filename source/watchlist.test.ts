import test from 'ava';
import {getNewWatchlistIssues, filterByLabels} from './watchlist.ts';
import type {TrackerIssue} from './providers/types.ts';

// ============================================================================
// Helper: create a TrackerIssue
// ============================================================================

function makeIssue(
	identifier: string,
	title = 'Test issue',
	stateName = 'To Do',
	labels?: string[],
): TrackerIssue {
	return {
		identifier,
		title,
		state: {name: stateName, type: 'unstarted', color: '#95a2b3'},
		project: null,
		labels,
	};
}

// ============================================================================
// getNewWatchlistIssues
// ============================================================================

test('returns issues not in existing spaces', t => {
	const discoveredIssues: TrackerIssue[] = [
		makeIssue('STA-10'),
		makeIssue('STA-20'),
		makeIssue('STA-30'),
	];
	const existingSpaces = ['STA-10'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	t.is(result.length, 2);
	t.is(result[0]!.identifier, 'STA-20');
	t.is(result[1]!.identifier, 'STA-30');
});

test('returns empty array when all issues already have spaces', t => {
	const discoveredIssues: TrackerIssue[] = [
		makeIssue('STA-10'),
		makeIssue('STA-20'),
	];
	const existingSpaces = ['STA-10', 'STA-20'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	t.deepEqual(result, []);
});

test('returns all issues when no existing spaces', t => {
	const discoveredIssues: TrackerIssue[] = [
		makeIssue('STA-10'),
		makeIssue('STA-20'),
	];
	const existingSpaces: string[] = [];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	t.is(result.length, 2);
});

test('returns empty array when no discovered issues', t => {
	const result = getNewWatchlistIssues([], ['STA-10']);
	t.deepEqual(result, []);
});

test('comparison is case-insensitive', t => {
	const discoveredIssues: TrackerIssue[] = [makeIssue('STA-10')];
	const existingSpaces = ['sta-10'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	t.deepEqual(result, []);
});

test('ignores main worktree in existing spaces', t => {
	const discoveredIssues: TrackerIssue[] = [makeIssue('STA-10')];
	const existingSpaces = ['main', 'STA-10'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	t.deepEqual(result, []);
});

// ============================================================================
// filterByLabels
// ============================================================================

test('filterByLabels returns all issues when labels array is empty', t => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['bug']),
		makeIssue('STA-2', 'B', 'To Do'),
	];

	const result = filterByLabels(issues, []);
	t.is(result.length, 2);
});

test('filterByLabels keeps issues matching any configured label', t => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['pappardelle']),
		makeIssue('STA-2', 'B', 'To Do', ['platform']),
		makeIssue('STA-3', 'C', 'To Do', ['stardust_jams']),
	];

	const result = filterByLabels(issues, ['pappardelle', 'platform']);
	t.is(result.length, 2);
	t.is(result[0]!.identifier, 'STA-1');
	t.is(result[1]!.identifier, 'STA-2');
});

test('filterByLabels excludes issues with no labels', t => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['pappardelle']),
		makeIssue('STA-2', 'B', 'To Do'), // no labels
		makeIssue('STA-3', 'C', 'To Do', []), // empty labels
	];

	const result = filterByLabels(issues, ['pappardelle']);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'STA-1');
});

test('filterByLabels is case-insensitive', t => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['Pappardelle']),
		makeIssue('STA-2', 'B', 'To Do', ['PLATFORM']),
	];

	const result = filterByLabels(issues, ['pappardelle', 'platform']);
	t.is(result.length, 2);
});

test('filterByLabels matches if issue has at least one matching label', t => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['bug', 'pappardelle', 'urgent']),
	];

	const result = filterByLabels(issues, ['pappardelle']);
	t.is(result.length, 1);
});

test('filterByLabels returns empty array when no issues match', t => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['stardust_jams']),
		makeIssue('STA-2', 'B', 'To Do', ['the_hive']),
	];

	const result = filterByLabels(issues, ['pappardelle']);
	t.deepEqual(result, []);
});
