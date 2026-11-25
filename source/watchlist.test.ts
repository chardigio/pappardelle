import {test, expect} from 'bun:test';
import {
	getNewWatchlistIssues,
	filterByLabels,
	filterByKeyPrefixes,
	sortIssuesByCreatedAt,
	watchlistSourceId,
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

test('returns issues not in existing spaces', () => {
	const discoveredIssues: TrackerIssue[] = [
		makeIssue('STA-10'),
		makeIssue('STA-20'),
		makeIssue('STA-30'),
	];
	const existingSpaces = ['STA-10'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	expect(result.length).toBe(2);
	expect(result[0]!.identifier).toBe('STA-20');
	expect(result[1]!.identifier).toBe('STA-30');
});

test('returns empty array when all issues already have spaces', () => {
	const discoveredIssues: TrackerIssue[] = [
		makeIssue('STA-10'),
		makeIssue('STA-20'),
	];
	const existingSpaces = ['STA-10', 'STA-20'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	expect(result).toStrictEqual([]);
});

test('returns all issues when no existing spaces', () => {
	const discoveredIssues: TrackerIssue[] = [
		makeIssue('STA-10'),
		makeIssue('STA-20'),
	];
	const existingSpaces: string[] = [];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	expect(result.length).toBe(2);
});

test('returns empty array when no discovered issues', () => {
	const result = getNewWatchlistIssues([], ['STA-10']);
	expect(result).toStrictEqual([]);
});

test('comparison is case-insensitive', () => {
	const discoveredIssues: TrackerIssue[] = [makeIssue('STA-10')];
	const existingSpaces = ['sta-10'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	expect(result).toStrictEqual([]);
});

test('ignores main worktree in existing spaces', () => {
	const discoveredIssues: TrackerIssue[] = [makeIssue('STA-10')];
	const existingSpaces = ['main', 'STA-10'];

	const result = getNewWatchlistIssues(discoveredIssues, existingSpaces);

	expect(result).toStrictEqual([]);
});

// ============================================================================
// filterByLabels
// ============================================================================

test('filterByLabels returns all issues when labels array is empty', () => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['bug']),
		makeIssue('STA-2', 'B', 'To Do'),
	];

	const result = filterByLabels(issues, []);
	expect(result.length).toBe(2);
});

test('filterByLabels keeps issues matching any configured label', () => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['pappardelle']),
		makeIssue('STA-2', 'B', 'To Do', ['platform']),
		makeIssue('STA-3', 'C', 'To Do', ['stardust_jams']),
	];

	const result = filterByLabels(issues, ['pappardelle', 'platform']);
	expect(result.length).toBe(2);
	expect(result[0]!.identifier).toBe('STA-1');
	expect(result[1]!.identifier).toBe('STA-2');
});

test('filterByLabels excludes issues with no labels', () => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['pappardelle']),
		makeIssue('STA-2', 'B', 'To Do'), // no labels
		makeIssue('STA-3', 'C', 'To Do', []), // empty labels
	];

	const result = filterByLabels(issues, ['pappardelle']);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('STA-1');
});

test('filterByLabels is case-insensitive', () => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['Pappardelle']),
		makeIssue('STA-2', 'B', 'To Do', ['PLATFORM']),
	];

	const result = filterByLabels(issues, ['pappardelle', 'platform']);
	expect(result.length).toBe(2);
});

test('filterByLabels matches if issue has at least one matching label', () => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['bug', 'pappardelle', 'urgent']),
	];

	const result = filterByLabels(issues, ['pappardelle']);
	expect(result.length).toBe(1);
});

test('filterByLabels returns empty array when no issues match', () => {
	const issues = [
		makeIssue('STA-1', 'A', 'To Do', ['stardust_jams']),
		makeIssue('STA-2', 'B', 'To Do', ['the_hive']),
	];

	const result = filterByLabels(issues, ['pappardelle']);
	expect(result).toStrictEqual([]);
});

// ============================================================================
// filterByKeyPrefixes
// ============================================================================

test('filterByKeyPrefixes returns all issues when prefixes array is empty', () => {
	// Off-by-default regression: an absent/empty config must watch every prefix,
	// identical to behavior before this option existed.
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, []);
	expect(result).toStrictEqual(issues);
});

test('filterByKeyPrefixes returns all issues when prefixes are only blanks', () => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, ['', '   ']);
	expect(result).toStrictEqual(issues);
});

test('filterByKeyPrefixes keeps only issues whose prefix is allowed', () => {
	const issues = [
		makeIssue('STA-1'),
		makeIssue('WAB-2'),
		makeIssue('STA-3'),
		makeIssue('ENG-4'),
	];

	const result = filterByKeyPrefixes(issues, ['STA']);
	expect(result.length).toBe(2);
	expect(result[0]!.identifier).toBe('STA-1');
	expect(result[1]!.identifier).toBe('STA-3');
});

test('filterByKeyPrefixes supports multiple allowed prefixes', () => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2'), makeIssue('ENG-3')];

	const result = filterByKeyPrefixes(issues, ['STA', 'ENG']);
	expect(result.length).toBe(2);
	expect(result[0]!.identifier).toBe('STA-1');
	expect(result[1]!.identifier).toBe('ENG-3');
});

test('filterByKeyPrefixes is case-insensitive for config prefixes', () => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, ['sta']);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('STA-1');
});

test('filterByKeyPrefixes is case-insensitive for issue identifiers', () => {
	const issues = [makeIssue('sta-1'), makeIssue('wab-2')];

	const result = filterByKeyPrefixes(issues, ['STA']);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('sta-1');
});

test('filterByKeyPrefixes trims whitespace around config prefixes', () => {
	const issues = [makeIssue('STA-1'), makeIssue('WAB-2')];

	const result = filterByKeyPrefixes(issues, ['  STA  ']);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('STA-1');
});

test('filterByKeyPrefixes returns empty array when no issues match', () => {
	const issues = [makeIssue('WAB-1'), makeIssue('ENG-2')];

	const result = filterByKeyPrefixes(issues, ['STA']);
	expect(result).toStrictEqual([]);
});

test('filterByKeyPrefixes only matches the full prefix, not a substring', () => {
	// "ST" must not match "STA-1"; the prefix token is compared whole.
	const issues = [makeIssue('STA-1'), makeIssue('ST-2')];

	const result = filterByKeyPrefixes(issues, ['ST']);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('ST-2');
});

test('filterByKeyPrefixes excludes hyphenless (malformed) identifiers', () => {
	// A key with no '-' yields its whole string as the prefix, which won't match
	// a normal allowlist entry — conservative allowlist behavior: don't spawn it.
	const issues = [makeIssue('STA-1'), makeIssue('MALFORMED')];

	const result = filterByKeyPrefixes(issues, ['STA']);
	expect(result.length).toBe(1);
	expect(result[0]!.identifier).toBe('STA-1');
});

test('filterByKeyPrefixes matches a beads prefix containing hyphens', () => {
	// Splitting on the first hyphen produced 'SEATGEEK', which matched nothing,
	// so the watchlist silently spawned zero workspaces.
	const issues = [
		makeIssue('seatgeek-ticket-management-cli-bqm'),
		makeIssue('other-hic'),
	];
	const filtered = filterByKeyPrefixes(issues, [
		'seatgeek-ticket-management-cli',
	]);
	expect(filtered.map(i => i.identifier)).toStrictEqual([
		'seatgeek-ticket-management-cli-bqm',
	]);
});

test('filterByKeyPrefixes ignores a beads child suffix', () => {
	const issues = [makeIssue('pap-a3f8e9.1')];
	expect(filterByKeyPrefixes(issues, ['pap']).length).toBe(1);
});

// ============================================================================
// sortIssuesByCreatedAt
// ============================================================================

function makeDatedIssue(identifier: string, createdAt?: string): TrackerIssue {
	return {...makeIssue(identifier), createdAt};
}

test('sortIssuesByCreatedAt puts the oldest issue first', () => {
	const issues = [
		makeDatedIssue('pappardelle-zz1', '2026-09-03T00:00:00Z'),
		makeDatedIssue('pappardelle-7yi', '2026-09-01T00:00:00Z'),
		makeDatedIssue('pappardelle-a2b', '2026-09-02T12:30:00Z'),
	];

	expect(sortIssuesByCreatedAt(issues).map(i => i.identifier)).toStrictEqual([
		'pappardelle-7yi',
		'pappardelle-a2b',
		'pappardelle-zz1',
	]);
});

test('sortIssuesByCreatedAt compares instants, not strings', () => {
	const issues = [
		makeDatedIssue('A-1', '2026-09-01T10:00:00+02:00'), // 08:00Z
		makeDatedIssue('A-2', '2026-09-01T09:00:00Z'),
		makeDatedIssue('A-3', '2026-09-01T07:00:00.000Z'),
	];

	expect(sortIssuesByCreatedAt(issues).map(i => i.identifier)).toStrictEqual([
		'A-3',
		'A-1',
		'A-2',
	]);
});

test('sortIssuesByCreatedAt keeps tracker order when createdAt is missing', () => {
	// The Jira provider returns issues without createdAt, already oldest first
	const issues = [
		makeDatedIssue('STE-40'),
		makeDatedIssue('STE-7'),
		makeDatedIssue('STE-12'),
	];

	expect(sortIssuesByCreatedAt(issues).map(i => i.identifier)).toStrictEqual([
		'STE-40',
		'STE-7',
		'STE-12',
	]);
});

test('sortIssuesByCreatedAt puts undated issues after dated ones', () => {
	const issues = [
		makeDatedIssue('A-3', '2026-09-03T00:00:00Z'),
		makeDatedIssue('A-9'),
		makeDatedIssue('A-1', '2026-09-01T00:00:00Z'),
		makeDatedIssue('A-8', 'not a date'),
	];

	expect(sortIssuesByCreatedAt(issues).map(i => i.identifier)).toStrictEqual([
		'A-1',
		'A-3',
		'A-9',
		'A-8',
	]);
});

test('sortIssuesByCreatedAt does not mutate its input', () => {
	const issues = [
		makeDatedIssue('A-2', '2026-09-02T00:00:00Z'),
		makeDatedIssue('A-1', '2026-09-01T00:00:00Z'),
	];

	sortIssuesByCreatedAt(issues);

	expect(issues.map(i => i.identifier)).toStrictEqual(['A-2', 'A-1']);
});

// ============================================================================
// watchlistSourceId
// ============================================================================

test('watchlistSourceId keeps the top-level watchlist apart from a profile named top-level', () => {
	expect(watchlistSourceId(null)).toBe('top-level');
	expect(watchlistSourceId('chaz')).toBe('profile:chaz');
	expect(watchlistSourceId('top-level')).not.toBe(watchlistSourceId(null));
});
