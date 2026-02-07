import test from 'ava';
import {routeSession} from './session-routing.ts';

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

test('routeSession provides correct status messages for issue keys', t => {
	const result = routeSession('STA-421', 'STA-421');
	t.is(result.statusStart, 'Starting STA-421...');
	t.is(result.statusSuccess, 'Opened STA-421');
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

test('routeSession provides correct status messages for descriptions', t => {
	const result = routeSession(null, 'fix the login bug');
	t.is(result.statusStart, 'Starting new IDOW session...');
	t.is(result.statusSuccess, 'IDOW session started!');
});

test('routeSession passes original input as-is for descriptions', t => {
	const input = 'implement user authentication with OAuth';
	const result = routeSession(null, input);
	t.deepEqual(result.args, [input]);
});
