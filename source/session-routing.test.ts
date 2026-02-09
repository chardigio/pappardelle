import test from 'ava';
import {
	routeSession,
	isPendingSessionResolved,
	type PendingSession,
} from './session-routing.ts';

// ============================================================================
// Issue Key Routing
// ============================================================================

test('routeSession routes issue key to idow with just the key', t => {
	const result = routeSession('STA-421', 'STA-421');
	t.is(result.type, 'issue');
	t.deepEqual(result.args, ['STA-421']);
});

test('routeSession routes expanded bare number to idow with just the key', t => {
	// normalizeIssueIdentifier('421', 'STA') returns 'STA-421'
	const result = routeSession('STA-421', '421');
	t.is(result.type, 'issue');
	t.deepEqual(result.args, ['STA-421']);
});

test('routeSession never passes --resume flag to idow', t => {
	// This is the critical regression test for STA-453.
	// The old code passed ['--resume', 'STA-421'] which idow didn't handle,
	// causing it to create a brand new issue with "--resume STA-421" as description.
	const result = routeSession('STA-421', 'STA-421');
	t.is(result.args.length, 1);
	t.false(result.args.includes('--resume'));
});

test('routeSession args contain only the issue key, nothing else', t => {
	const result = routeSession('STA-100', 'STA-100');
	t.deepEqual(result.args, ['STA-100']);
});

test('routeSession provides issue key for issue routes', t => {
	const result = routeSession('STA-421', 'STA-421');
	t.is(result.issueKey, 'STA-421');
});

test('routeSession provides sentence-case pending title for issue routes', t => {
	const result = routeSession('STA-421', 'STA-421');
	t.is(result.pendingTitle, 'Resuming\u2026');
});

test('routeSession preserves non-default team prefix in args', t => {
	const result = routeSession('ENG-100', 'ENG-100');
	t.is(result.type, 'issue');
	t.deepEqual(result.args, ['ENG-100']);
});

// ============================================================================
// Description Routing
// ============================================================================

test('routeSession routes null issue key as description', t => {
	const result = routeSession(null, 'add dark mode to settings');
	t.is(result.type, 'description');
	t.deepEqual(result.args, ['add dark mode to settings']);
});

test('routeSession provides sentence-case pending title for descriptions', t => {
	const result = routeSession(null, 'fix the login bug');
	t.is(result.pendingTitle, 'Starting new session\u2026');
});

test('routeSession provides null issue key for descriptions', t => {
	const result = routeSession(null, 'fix the login bug');
	t.is(result.issueKey, null);
});

test('routeSession passes original input as-is for descriptions', t => {
	const input = 'implement user authentication with OAuth';
	const result = routeSession(null, input);
	t.deepEqual(result.args, [input]);
});

// ============================================================================
// isPendingSessionResolved
// ============================================================================

test('resolves when issue key appears in spaces', t => {
	const pending: PendingSession = {
		type: 'issue',
		name: 'STA-464',
		idowArg: 'STA-464',
		pendingTitle: 'Resuming\u2026',
		prevSpaceCount: 1,
	};
	t.true(isPendingSessionResolved(pending, ['STA-463', 'STA-464']));
});

test('does not resolve when issue key is absent from spaces', t => {
	const pending: PendingSession = {
		type: 'issue',
		name: 'STA-464',
		idowArg: 'STA-464',
		pendingTitle: 'Resuming\u2026',
		prevSpaceCount: 1,
	};
	t.false(isPendingSessionResolved(pending, ['STA-463']));
});

test('resolves description session when space count increases', t => {
	const pending: PendingSession = {
		type: 'description',
		name: '',
		idowArg: 'add dark mode',
		pendingTitle: 'Starting new session\u2026',
		prevSpaceCount: 1,
	};
	t.true(isPendingSessionResolved(pending, ['STA-463', 'STA-464']));
});

test('does not resolve description session when count unchanged', t => {
	const pending: PendingSession = {
		type: 'description',
		name: '',
		idowArg: 'add dark mode',
		pendingTitle: 'Starting new session\u2026',
		prevSpaceCount: 1,
	};
	t.false(isPendingSessionResolved(pending, ['STA-463']));
});
