import test from 'ava';
import {getNewWatchlistIssues} from './watchlist.ts';
import type {TrackerIssue} from './providers/types.ts';

// ============================================================================
// Helper: create a TrackerIssue
// ============================================================================

function makeIssue(
	identifier: string,
	title = 'Test issue',
	stateName = 'To Do',
): TrackerIssue {
	return {
		identifier,
		title,
		state: {name: stateName, type: 'unstarted', color: '#95a2b3'},
		project: null,
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
