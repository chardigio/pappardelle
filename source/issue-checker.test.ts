import {test, expect} from 'bun:test';
import {
	isBeadsIssueKey,
	issueKeyPrefix,
	isLinearIssueKey,
	isIssueKey,
	isIssueNumber,
	issueKeyTeamPrefix,
	normalizeIssueIdentifier,
} from './issue-utils.ts';

// ============================================================================
// isLinearIssueKey Tests
// ============================================================================

test('isLinearIssueKey returns true for standard format STA-123', () => {
	expect(isLinearIssueKey('STA-123')).toBe(true);
});

test('isLinearIssueKey returns true for lowercase sta-123', () => {
	expect(isLinearIssueKey('sta-123')).toBe(true);
});

test('isLinearIssueKey returns true for mixed case Sta-456', () => {
	expect(isLinearIssueKey('Sta-456')).toBe(true);
});

test('isLinearIssueKey returns true with whitespace padding', () => {
	expect(isLinearIssueKey('  STA-789  ')).toBe(true);
});

test('isLinearIssueKey returns false for bare numbers', () => {
	expect(isLinearIssueKey('400')).toBe(false);
});

test('isLinearIssueKey returns false for empty string', () => {
	expect(isLinearIssueKey('')).toBe(false);
});

test('isLinearIssueKey returns true for alphanumeric prefix B2B-100', () => {
	expect(isLinearIssueKey('B2B-100')).toBe(true);
});

test('isLinearIssueKey returns true for alphanumeric prefix A1-50', () => {
	expect(isLinearIssueKey('A1-50')).toBe(true);
});

test('isLinearIssueKey returns false for number-only prefix 123-456', () => {
	expect(isLinearIssueKey('123-456')).toBe(false);
});

test('isLinearIssueKey returns false for descriptions', () => {
	expect(isLinearIssueKey('fix the bug')).toBe(false);
});

// ============================================================================
// isIssueNumber Tests
// ============================================================================

test('isIssueNumber returns true for bare number 400', () => {
	expect(isIssueNumber('400')).toBe(true);
});

test('isIssueNumber returns true for bare number with whitespace', () => {
	expect(isIssueNumber('  123  ')).toBe(true);
});

test('isIssueNumber returns true for single digit', () => {
	expect(isIssueNumber('1')).toBe(true);
});

test('isIssueNumber returns false for STA-123', () => {
	expect(isIssueNumber('STA-123')).toBe(false);
});

test('isIssueNumber returns false for text', () => {
	expect(isIssueNumber('abc')).toBe(false);
});

test('isIssueNumber returns false for mixed', () => {
	expect(isIssueNumber('123abc')).toBe(false);
});

test('isIssueNumber returns false for empty string', () => {
	expect(isIssueNumber('')).toBe(false);
});

test('isIssueNumber returns false for negative number', () => {
	expect(isIssueNumber('-123')).toBe(false);
});

test('isIssueNumber returns false for decimal', () => {
	expect(isIssueNumber('12.3')).toBe(false);
});

// ============================================================================
// issueKeyTeamPrefix Tests
// ============================================================================

test('issueKeyTeamPrefix returns the prefix of a standard key', () => {
	expect(issueKeyTeamPrefix('STA-123')).toBe('STA');
});

test('issueKeyTeamPrefix uppercases a lowercase key', () => {
	expect(issueKeyTeamPrefix('sta-123')).toBe('STA');
});

test('issueKeyTeamPrefix tolerates whitespace padding', () => {
	expect(issueKeyTeamPrefix('  STA-789  ')).toBe('STA');
});

test('issueKeyTeamPrefix handles an alphanumeric prefix', () => {
	expect(issueKeyTeamPrefix('B2B-100')).toBe('B2B');
});

test('issueKeyTeamPrefix reads the prefix out of a Linear issue URL', () => {
	expect(
		issueKeyTeamPrefix('https://linear.app/acme/issue/ENG-456/some-slug'),
	).toBe('ENG');
});

test('issueKeyTeamPrefix reads a Linear URL carrying an extra path segment', () => {
	// Linear emits both /<workspace>/issue/KEY and /<workspace>/team/issue/KEY;
	// idow and determineProfileForInput both accept the longer form.
	expect(
		issueKeyTeamPrefix('https://linear.app/acme/team/issue/ENG-456/slug'),
	).toBe('ENG');
});

test('issueKeyTeamPrefix returns null for a bare number', () => {
	// A bare number borrows its prefix from config, so it states none itself.
	expect(issueKeyTeamPrefix('400')).toBe(null);
});

test('issueKeyTeamPrefix returns null for prose and for empty input', () => {
	expect(issueKeyTeamPrefix('fix the login page')).toBe(null);
	expect(issueKeyTeamPrefix('')).toBe(null);
});

// ============================================================================
// normalizeIssueIdentifier Tests
// ============================================================================

test('normalizeIssueIdentifier returns uppercase STA-400 for bare number 400', () => {
	expect(normalizeIssueIdentifier('400', 'STA', 'linear', [])).toBe('STA-400');
});

test('normalizeIssueIdentifier returns uppercase STA-123 for lowercase sta-123', () => {
	expect(normalizeIssueIdentifier('sta-123', 'STA', 'linear', [])).toBe(
		'STA-123',
	);
});

test('normalizeIssueIdentifier returns uppercase for mixed case Sta-456', () => {
	expect(normalizeIssueIdentifier('Sta-456', 'STA', 'linear', [])).toBe(
		'STA-456',
	);
});

test('normalizeIssueIdentifier trims whitespace', () => {
	expect(normalizeIssueIdentifier('  400  ', 'STA', 'linear', [])).toBe(
		'STA-400',
	);
	expect(normalizeIssueIdentifier('  STA-400  ', 'STA', 'linear', [])).toBe(
		'STA-400',
	);
});

test('normalizeIssueIdentifier returns null for descriptions', () => {
	expect(normalizeIssueIdentifier('fix the bug', 'STA', 'linear', [])).toBe(
		null,
	);
});

test('normalizeIssueIdentifier returns null for empty string', () => {
	expect(normalizeIssueIdentifier('', 'STA', 'linear', [])).toBe(null);
});

test('normalizeIssueIdentifier works with different team prefixes', () => {
	expect(normalizeIssueIdentifier('100', 'ENG', 'linear', [])).toBe('ENG-100');
	expect(normalizeIssueIdentifier('eng-100', 'ENG', 'linear', [])).toBe(
		'ENG-100',
	);
});

test('normalizeIssueIdentifier preserves original team prefix when different from default', () => {
	// If user types ENG-100 but default is STA, keep ENG-100
	expect(normalizeIssueIdentifier('ENG-100', 'STA', 'linear', [])).toBe(
		'ENG-100',
	);
});

test('normalizeIssueIdentifier works with alphanumeric prefixes', () => {
	expect(normalizeIssueIdentifier('b2b-100', 'B2B', 'linear', [])).toBe(
		'B2B-100',
	);
	expect(normalizeIssueIdentifier('B2B-200', 'STA', 'linear', [])).toBe(
		'B2B-200',
	);
	expect(normalizeIssueIdentifier('100', 'B2B', 'linear', [])).toBe('B2B-100');
});

// ============================================================================
// isIssueKey Tests (provider-agnostic alias)
// ============================================================================

test('isIssueKey is an alias for isLinearIssueKey', () => {
	expect(isIssueKey).toBe(isLinearIssueKey);
});

test('isIssueKey works for standard format', () => {
	expect(isIssueKey('STA-123')).toBe(true);
	expect(isIssueKey('PROJ-456')).toBe(true);
	expect(isIssueKey('fix bug')).toBe(false);
	expect(isIssueKey('400')).toBe(false);
});

// ============================================================================
// issueKeyPrefix Tests
// ============================================================================

test('issueKeyPrefix splits on the last hyphen', () => {
	expect(issueKeyPrefix('STA-123')).toBe('STA');
	expect(issueKeyPrefix('bd-a1b2')).toBe('bd');
});

test('issueKeyPrefix keeps hyphens inside a beads prefix', () => {
	// Splitting on the first hyphen instead silently broke watchlist filtering
	// for these repos.
	expect(issueKeyPrefix('seatgeek-ticket-management-cli-bqm')).toBe(
		'seatgeek-ticket-management-cli',
	);
});

test('issueKeyPrefix drops a hierarchical child suffix', () => {
	expect(issueKeyPrefix('bd-a3f8e9.1')).toBe('bd');
	expect(issueKeyPrefix('bd-a3f8e9.1.2')).toBe('bd');
});

test('issueKeyPrefix yields the whole string when there is no hyphen', () => {
	// Allowlist callers then exclude it rather than matching everything.
	expect(issueKeyPrefix('nohyphen')).toBe('nohyphen');
});

// ============================================================================
// isBeadsIssueKey Tests
// ============================================================================

test('isBeadsIssueKey accepts hash-suffixed IDs of a known prefix', () => {
	expect(isBeadsIssueKey('bd-a1b2', ['bd'])).toBe(true);
	expect(isBeadsIssueKey('sddamico-hic', ['sddamico'])).toBe(true);
});

test('isBeadsIssueKey accepts a prefix containing hyphens', () => {
	// The prefix defaults to the repo directory name.
	expect(
		isBeadsIssueKey('seatgeek-ticket-management-cli-bqm', [
			'seatgeek-ticket-management-cli',
		]),
	).toBe(true);
});

test('isBeadsIssueKey accepts a prefix containing underscores', () => {
	// The repo directory name a prefix defaults to may be snake_case, and the
	// tmux session encoding already treats these as valid keys.
	expect(isBeadsIssueKey('my_service-a1b2', ['my_service'])).toBe(true);
	expect(isBeadsIssueKey('my_service-sub_x1', ['my_service'])).toBe(true);
});

test('isBeadsIssueKey accepts hierarchical child IDs', () => {
	expect(isBeadsIssueKey('bd-a3f8e9.1', ['bd'])).toBe(true);
	expect(isBeadsIssueKey('bd-a3f8e9.1.2.3', ['bd'])).toBe(true);
});

test('isBeadsIssueKey rejects nesting deeper than beads allows', () => {
	expect(isBeadsIssueKey('bd-a3f8e9.1.2.3.4', ['bd'])).toBe(false);
});

test('isBeadsIssueKey rejects a hyphenated phrase that is not a known prefix', () => {
	// A beads hash can be pure letters, so shape alone cannot tell 'dark-mode'
	// from an ID — without the prefix anchor these would be sent to idow as
	// existing keys and die on a lookup instead of creating an issue.
	expect(isBeadsIssueKey('dark-mode', ['bd'])).toBe(false);
	expect(isBeadsIssueKey('fix-crash', ['bd'])).toBe(false);
});

test('isBeadsIssueKey matches the prefix case-insensitively', () => {
	expect(isBeadsIssueKey('BD-A1B2', ['bd'])).toBe(true);
	expect(isBeadsIssueKey('bd-a1b2', ['BD'])).toBe(true);
});

test('isBeadsIssueKey rejects everything when no prefixes are known', () => {
	expect(isBeadsIssueKey('bd-a1b2', [])).toBe(false);
});

test('isBeadsIssueKey rejects prose and bare numbers', () => {
	expect(isBeadsIssueKey('fix the bug', ['bd'])).toBe(false);
	expect(isBeadsIssueKey('400', ['bd'])).toBe(false);
	expect(isBeadsIssueKey('nohyphen', ['bd'])).toBe(false);
});

// ============================================================================
// normalizeIssueIdentifier — beads
// ============================================================================

test('normalizeIssueIdentifier lowercases beads IDs', () => {
	// Uppercasing would yield an ID bd cannot resolve and a worktree named
	// unlike its issue.
	expect(normalizeIssueIdentifier('bd-a1b2', 'bd', 'beads', ['bd'])).toBe(
		'bd-a1b2',
	);
	expect(normalizeIssueIdentifier('BD-A1B2', 'bd', 'beads', ['bd'])).toBe(
		'bd-a1b2',
	);
	expect(
		normalizeIssueIdentifier('sddamico-hic', 'sddamico', 'beads', ['sddamico']),
	).toBe('sddamico-hic');
});

test('normalizeIssueIdentifier keeps beads child IDs intact', () => {
	expect(normalizeIssueIdentifier('bd-a3f8e9.1', 'bd', 'beads', ['bd'])).toBe(
		'bd-a3f8e9.1',
	);
	expect(normalizeIssueIdentifier('BD-A3F8E9.1', 'bd', 'beads', ['bd'])).toBe(
		'bd-a3f8e9.1',
	);
});

test('normalizeIssueIdentifier accepts a beads ID from any known prefix', () => {
	expect(
		normalizeIssueIdentifier('vendor-sdk-hic', 'bd', 'beads', [
			'bd',
			'vendor-sdk',
		]),
	).toBe('vendor-sdk-hic');
});

test('normalizeIssueIdentifier treats an unknown-prefix phrase as a description', () => {
	expect(normalizeIssueIdentifier('dark-mode', 'bd', 'beads', ['bd'])).toBe(
		null,
	);
});

test('normalizeIssueIdentifier lowercases the prefix for a bare beads number', () => {
	// Only resolves in databases old enough to have sequential IDs, but the
	// prefix is lowercase either way.
	expect(normalizeIssueIdentifier('42', 'BD', 'beads', ['bd'])).toBe('bd-42');
});

test('normalizeIssueIdentifier returns null for beads descriptions', () => {
	expect(normalizeIssueIdentifier('fix the bug', 'bd', 'beads', ['bd'])).toBe(
		null,
	);
});

test('normalizeIssueIdentifier still uppercases for linear and jira', () => {
	// Regression pin: adding the beads grammar must not touch the others.
	expect(normalizeIssueIdentifier('sta-123', 'STA', 'linear', [])).toBe(
		'STA-123',
	);
	expect(normalizeIssueIdentifier('sta-123', 'STA', 'jira', [])).toBe(
		'STA-123',
	);
});

test('normalizeIssueIdentifier needs a beads prefix to read a beads key', () => {
	// An empty allowlist is what a caller with no config passes, and nothing
	// about `dark-mode`'s shape distinguishes it from an ID — so nothing matches.
	expect(normalizeIssueIdentifier('bd-a1b2', 'bd', 'beads', [])).toBe(null);
});
