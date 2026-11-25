import {test, expect} from 'bun:test';
import {isSimctlUnavailableError} from './simctl-check.ts';

// ============================================================================
// isSimctlUnavailableError
// When xcrun exists but simctl is not available (no Xcode installed),
// `xcrun simctl list` fails with a specific error message. This should be
// treated as a graceful skip (like xcrun not being installed), not an error.
// ============================================================================

test('detects "unable to find utility simctl" as unavailable', () => {
	expect(
		isSimctlUnavailableError(
			'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH',
		),
	).toBe(true);
});

test('detects partial simctl-not-found message', () => {
	expect(isSimctlUnavailableError('unable to find utility "simctl"')).toBe(
		true,
	);
});

test('returns false for empty string', () => {
	expect(isSimctlUnavailableError('')).toBe(false);
});

test('returns false for unrelated error', () => {
	expect(isSimctlUnavailableError('connection refused')).toBe(false);
});

test('returns false for other xcrun errors', () => {
	expect(
		isSimctlUnavailableError('xcrun: error: invalid active developer path'),
	).toBe(false);
});
