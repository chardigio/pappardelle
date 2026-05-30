import test from 'ava';
import {
	getNewWatchlistIssues,
	filterByLabels,
	filterByKeyPrefixes,
} from './watchlist.ts';
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

// ============================================================================
// filterByKeyPrefixes
// ============================================================================

test('filterByKeyPrefixes returns all issues when prefixes array is empty', t => {
	// Off-by-default regression: an absent/empty config must watch every prefix,
	// identical to behavior before this option existed.
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, []);
	t.deepEqual(result, issues);
});

test('filterByKeyPrefixes returns all issues when prefixes are only blanks', t => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, ['', '   ']);
	t.deepEqual(result, issues);
});

test('filterByKeyPrefixes keeps only issues whose prefix is allowed', t => {
	const issues = [
		makeIssue('STA-1'),
		makeIssue('WAB-2'),
		makeIssue('STA-3'),
		makeIssue('ENG-4'),
	];

	const result = filterByKeyPrefixes(issues, ['STA']);
	t.is(result.length, 2);
	t.is(result[0]!.identifier, 'STA-1');
	t.is(result[1]!.identifier, 'STA-3');
});

test('filterByKeyPrefixes supports multiple allowed prefixes', t => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2'), makeIssue('ENG-3')];

	const result = filterByKeyPrefixes(issues, ['STA', 'ENG']);
	t.is(result.length, 2);
	t.is(result[0]!.identifier, 'STA-1');
	t.is(result[1]!.identifier, 'ENG-3');
});

test('filterByKeyPrefixes is case-insensitive for config prefixes', t => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, ['sta']);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'STA-1');
});

test('filterByKeyPrefixes is case-insensitive for issue identifiers', t => {
	const issues = [makeIssue('sta-1'), makeIssue('wab-2')];

	const result = filterByKeyPrefixes(issues, ['STA']);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'sta-1');
});

test('filterByKeyPrefixes trims whitespace around config prefixes', t => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, ['  STA  ']);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'STA-1');
});

test('filterByKeyPrefixes returns empty array when no issues match', t => {
	const issues = [makeIssue('WAB-1'), makeIssue('ENG-2')];

	const result = filterByKeyPrefixes(issues, ['STA']);
	t.deepEqual(result, []);
});

test('filterByKeyPrefixes only matches the full prefix, not a substring', t => {
	// "ST" must not match "STA-1"; the prefix token is compared whole.
	const issues = [makeIssue('STA-1'), makeIssue('ST-2')];

	const result = filterByKeyPrefixes(issues, ['ST']);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'ST-2');
});

test('filterByKeyPrefixes excludes hyphenless (malformed) identifiers', t => {
	// A key with no '-' yields its whole string as the prefix, which won't match
	// a normal allowlist entry — conservative allowlist behavior: don't spawn it.
	const issues = [makeIssue('STA-1'), makeIssue('MALFORMED')];

	const result = filterByKeyPrefixes(issues, ['STA']);
	t.is(result.length, 1);
	t.is(result[0]!.identifier, 'STA-1');
});
