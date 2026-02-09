import test from 'ava';
import {
	isLinearIssueKey,
	isIssueKey,
	isIssueNumber,
	normalizeIssueIdentifier,
} from './issue-utils.ts';

// ============================================================================
// isLinearIssueKey Tests
// ============================================================================

test('isLinearIssueKey returns true for standard format STA-123', t => {
	t.true(isLinearIssueKey('STA-123'));
});

test('isLinearIssueKey returns true for lowercase sta-123', t => {
	t.true(isLinearIssueKey('sta-123'));
});

test('isLinearIssueKey returns true for mixed case Sta-456', t => {
	t.true(isLinearIssueKey('Sta-456'));
});

test('isLinearIssueKey returns true with whitespace padding', t => {
	t.true(isLinearIssueKey('  STA-789  '));
});

test('isLinearIssueKey returns false for bare numbers', t => {
	t.false(isLinearIssueKey('400'));
});

test('isLinearIssueKey returns false for empty string', t => {
	t.false(isLinearIssueKey(''));
});

test('isLinearIssueKey returns false for descriptions', t => {
	t.false(isLinearIssueKey('fix the bug'));
});

// ============================================================================
// isIssueNumber Tests
// ============================================================================

test('isIssueNumber returns true for bare number 400', t => {
	t.true(isIssueNumber('400'));
});

test('isIssueNumber returns true for bare number with whitespace', t => {
	t.true(isIssueNumber('  123  '));
});

test('isIssueNumber returns true for single digit', t => {
	t.true(isIssueNumber('1'));
});

test('isIssueNumber returns false for STA-123', t => {
	t.false(isIssueNumber('STA-123'));
});

test('isIssueNumber returns false for text', t => {
	t.false(isIssueNumber('abc'));
});

test('isIssueNumber returns false for mixed', t => {
	t.false(isIssueNumber('123abc'));
});

test('isIssueNumber returns false for empty string', t => {
	t.false(isIssueNumber(''));
});

test('isIssueNumber returns false for negative number', t => {
	t.false(isIssueNumber('-123'));
});

test('isIssueNumber returns false for decimal', t => {
	t.false(isIssueNumber('12.3'));
});

// ============================================================================
// normalizeIssueIdentifier Tests
// ============================================================================

test('normalizeIssueIdentifier returns uppercase STA-400 for bare number 400', t => {
	t.is(normalizeIssueIdentifier('400', 'STA'), 'STA-400');
});

test('normalizeIssueIdentifier returns uppercase STA-123 for lowercase sta-123', t => {
	t.is(normalizeIssueIdentifier('sta-123', 'STA'), 'STA-123');
});

test('normalizeIssueIdentifier returns uppercase for mixed case Sta-456', t => {
	t.is(normalizeIssueIdentifier('Sta-456', 'STA'), 'STA-456');
});

test('normalizeIssueIdentifier trims whitespace', t => {
	t.is(normalizeIssueIdentifier('  400  ', 'STA'), 'STA-400');
	t.is(normalizeIssueIdentifier('  STA-400  ', 'STA'), 'STA-400');
});

test('normalizeIssueIdentifier returns null for descriptions', t => {
	t.is(normalizeIssueIdentifier('fix the bug', 'STA'), null);
});

test('normalizeIssueIdentifier returns null for empty string', t => {
	t.is(normalizeIssueIdentifier('', 'STA'), null);
});

test('normalizeIssueIdentifier works with different team prefixes', t => {
	t.is(normalizeIssueIdentifier('100', 'ENG'), 'ENG-100');
	t.is(normalizeIssueIdentifier('eng-100', 'ENG'), 'ENG-100');
});

test('normalizeIssueIdentifier preserves original team prefix when different from default', t => {
	// If user types ENG-100 but default is STA, keep ENG-100
	t.is(normalizeIssueIdentifier('ENG-100', 'STA'), 'ENG-100');
});

// ============================================================================
// isIssueKey Tests (provider-agnostic alias)
// ============================================================================

test('isIssueKey is an alias for isLinearIssueKey', t => {
	t.is(isIssueKey, isLinearIssueKey);
});

test('isIssueKey works for standard format', t => {
	t.true(isIssueKey('STA-123'));
	t.true(isIssueKey('PROJ-456'));
	t.false(isIssueKey('fix bug'));
	t.false(isIssueKey('400'));
});
