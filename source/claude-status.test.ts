import test from 'ava';
import type {ClaudeStatus, ClaudeSessionState} from './types.ts';
// Import from compiled dist to avoid logger.js resolution issues during tsx execution
import {
	STABLE_STATUSES,
	ACTIVE_STATUSES,
	ACTIVE_STATUS_TIMEOUT,
} from '../dist/claude-status.js';

// ============================================================================
// Helper Functions
// ============================================================================

function createStatusFile(
	dir: string,
	workspace: string,
	status: ClaudeStatus,
	lastUpdate: number,
): void {
	const state: ClaudeSessionState = {
		sessionId: 'test-session',
		workspaceName: workspace,
		status,
		lastUpdate,
	};
	writeFileSync(join(dir, `${workspace}.json`), JSON.stringify(state, null, 2));
}

// ============================================================================
// STABLE_STATUSES Tests
// ============================================================================

test('STABLE_STATUSES includes done', t => {
	t.true(STABLE_STATUSES.has('done'), 'done should be a stable status');
});

test('STABLE_STATUSES includes idle', t => {
	t.true(STABLE_STATUSES.has('idle'), 'idle should be a stable status');
});

test('STABLE_STATUSES includes waiting_input', t => {
	t.true(
		STABLE_STATUSES.has('waiting_input'),
		'waiting_input should be a stable status',
	);
});

test('STABLE_STATUSES includes waiting_permission', t => {
	t.true(
		STABLE_STATUSES.has('waiting_permission'),
		'waiting_permission should be a stable status',
	);
});

test('STABLE_STATUSES includes error', t => {
	t.true(
		STABLE_STATUSES.has('error'),
		'error should be a stable status (persists until resolved)',
	);
});

test('STABLE_STATUSES does not include thinking', t => {
	t.false(
		STABLE_STATUSES.has('thinking'),
		'thinking is an active status, not stable',
	);
});

test('STABLE_STATUSES does not include tool_use', t => {
	t.false(
		STABLE_STATUSES.has('tool_use'),
		'tool_use is an active status, not stable',
	);
});

test('STABLE_STATUSES does not include unknown', t => {
	t.false(
		STABLE_STATUSES.has('unknown'),
		'unknown is a fallback, not a real status',
	);
});

// ============================================================================
// ACTIVE_STATUSES Tests
// ============================================================================

test('ACTIVE_STATUSES includes thinking', t => {
	t.true(
		ACTIVE_STATUSES.has('thinking'),
		'thinking should be an active status',
	);
});

test('ACTIVE_STATUSES includes tool_use', t => {
	t.true(
		ACTIVE_STATUSES.has('tool_use'),
		'tool_use should be an active status',
	);
});

test('ACTIVE_STATUSES does not include done', t => {
	t.false(ACTIVE_STATUSES.has('done'), 'done is a stable status, not active');
});

test('ACTIVE_STATUSES does not include idle', t => {
	t.false(ACTIVE_STATUSES.has('idle'), 'idle is a stable status, not active');
});

test('ACTIVE_STATUSES has exactly 2 statuses', t => {
	t.is(
		ACTIVE_STATUSES.size,
		2,
		'Only thinking and tool_use should be active statuses',
	);
});

// ============================================================================
// ACTIVE_STATUS_TIMEOUT Tests
// ============================================================================

test('ACTIVE_STATUS_TIMEOUT is 10 minutes', t => {
	const tenMinutesMs = 10 * 60 * 1000;
	t.is(
		ACTIVE_STATUS_TIMEOUT,
		tenMinutesMs,
		'Active statuses should become stale after 10 minutes',
	);
});

// ============================================================================
// Complete Status Coverage Test
// ============================================================================

test('All ClaudeStatus types are categorized', t => {
	// All possible statuses from the ClaudeStatus type
	const allStatuses: ClaudeStatus[] = [
		'idle',
		'thinking',
		'tool_use',
		'waiting_input',
		'waiting_permission',
		'done',
		'error',
		'unknown',
	];

	// Statuses that should be in one of the sets
	const categorizedStatuses = allStatuses.filter(
		s => s !== 'unknown', // unknown is the fallback, not a real status
	);

	for (const status of categorizedStatuses) {
		const isInStable = STABLE_STATUSES.has(status);
		const isInActive = ACTIVE_STATUSES.has(status);

		t.true(
			isInStable || isInActive,
			`Status '${status}' should be in either STABLE_STATUSES or ACTIVE_STATUSES`,
		);

		t.false(
			isInStable && isInActive,
			`Status '${status}' should not be in both STABLE_STATUSES and ACTIVE_STATUSES`,
		);
	}
});

// ============================================================================
// Status Display Tests
// These verify the icon/color mapping is correct
// ============================================================================

test('CLAUDE_STATUS_DISPLAY has correct icon for waiting_input', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_input.icon,
		'?',
		'waiting_input should show ? icon',
	);
	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_input.color,
		'blue',
		'waiting_input should be blue',
	);
});

test('CLAUDE_STATUS_DISPLAY has correct icon for waiting_permission', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_permission.icon,
		'!',
		'waiting_permission should show ! icon',
	);
	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_permission.color,
		'red',
		'waiting_permission should be red',
	);
});

test('CLAUDE_STATUS_DISPLAY has correct icon for done', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(CLAUDE_STATUS_DISPLAY.done.icon, '✓', 'done should show ✓ icon');
	t.is(CLAUDE_STATUS_DISPLAY.done.color, 'green', 'done should be green');
});

test('CLAUDE_STATUS_DISPLAY shows ? for unknown (fallback)', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(
		CLAUDE_STATUS_DISPLAY.unknown.icon,
		'?',
		'unknown should show ? icon as fallback',
	);
	t.is(CLAUDE_STATUS_DISPLAY.unknown.color, 'gray', 'unknown should be gray');
});

test('CLAUDE_STATUS_DISPLAY has correct icon for error', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(CLAUDE_STATUS_DISPLAY.error.icon, '✗', 'error should show ✗ icon');
	t.is(CLAUDE_STATUS_DISPLAY.error.color, 'red', 'error should be red');
});
