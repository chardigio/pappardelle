import test from 'ava';
import {isSimctlUnavailableError} from './simctl-check.ts';

// ============================================================================
// isSimctlUnavailableError
// When xcrun exists but simctl is not available (no Xcode installed),
// `xcrun simctl list` fails with a specific error message. This should be
// treated as a graceful skip (like xcrun not being installed), not an error.
// ============================================================================

test('detects "unable to find utility simctl" as unavailable', t => {
	t.true(
		isSimctlUnavailableError(
			'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH',
		),
	);
});

test('detects partial simctl-not-found message', t => {
	t.true(isSimctlUnavailableError('unable to find utility "simctl"'));
});

test('returns false for empty string', t => {
	t.false(isSimctlUnavailableError(''));
});

test('returns false for unrelated error', t => {
	t.false(isSimctlUnavailableError('connection refused'));
});

test('returns false for other xcrun errors', t => {
	t.false(
		isSimctlUnavailableError('xcrun: error: invalid active developer path'),
	);
});
