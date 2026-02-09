import test from 'ava';
import {
	routeSession,
	isPendingSessionResolved,
	type PendingSession,
} from './session-routing.ts';

// ============================================================================
// Issue Key Routing
// ============================================================================

test('routeSession routes issue key as issue type', t => {
	const result = routeSession('STA-421');
	t.is(result.type, 'issue');
	t.is(result.issueKey, 'STA-421');
});

test('routeSession provides sentence-case pending title for issue routes', t => {
	const result = routeSession('STA-421');
	t.is(result.pendingTitle, 'Resuming\u2026');
});

test('routeSession preserves non-default team prefix', t => {
	const result = routeSession('ENG-100');
	t.is(result.type, 'issue');
	t.is(result.issueKey, 'ENG-100');
});

// ============================================================================
// Description Routing
// ============================================================================

test('routeSession routes null issue key as description', t => {
	const result = routeSession(null);
	t.is(result.type, 'description');
	t.is(result.issueKey, null);
});

test('routeSession provides sentence-case pending title for descriptions', t => {
	const result = routeSession(null);
	t.is(result.pendingTitle, 'Starting new session\u2026');
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
