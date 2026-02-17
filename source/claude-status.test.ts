import test from 'ava';
import type {ClaudeStatus, ClaudeSessionState} from './types.ts';
import {
	STABLE_STATUSES,
	ACTIVE_STATUSES,
	ACTIVE_STATUS_TIMEOUT,
} from './types.ts';
import {findSpaceByStatusKey} from './claude-status.ts';

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

test('STABLE_STATUSES includes waiting_for_input', t => {
	t.true(
		STABLE_STATUSES.has('waiting_for_input'),
		'waiting_for_input should be a stable status',
	);
});

test('STABLE_STATUSES includes waiting_for_approval', t => {
	t.true(
		STABLE_STATUSES.has('waiting_for_approval'),
		'waiting_for_approval should be a stable status',
	);
});

test('STABLE_STATUSES includes ended', t => {
	t.true(STABLE_STATUSES.has('ended'), 'ended should be a stable status');
});

test('STABLE_STATUSES includes error', t => {
	t.true(
		STABLE_STATUSES.has('error'),
		'error should be a stable status (persists until resolved)',
	);
});

test('STABLE_STATUSES does not include processing', t => {
	t.false(
		STABLE_STATUSES.has('processing'),
		'processing is an active status, not stable',
	);
});

test('STABLE_STATUSES does not include running_tool', t => {
	t.false(
		STABLE_STATUSES.has('running_tool'),
		'running_tool is an active status, not stable',
	);
});

test('STABLE_STATUSES does not include compacting', t => {
	t.false(
		STABLE_STATUSES.has('compacting'),
		'compacting is an active status, not stable',
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

test('ACTIVE_STATUSES includes processing', t => {
	t.true(
		ACTIVE_STATUSES.has('processing'),
		'processing should be an active status',
	);
});

test('ACTIVE_STATUSES includes running_tool', t => {
	t.true(
		ACTIVE_STATUSES.has('running_tool'),
		'running_tool should be an active status',
	);
});

test('ACTIVE_STATUSES includes compacting', t => {
	t.true(
		ACTIVE_STATUSES.has('compacting'),
		'compacting should be an active status',
	);
});

test('ACTIVE_STATUSES does not include waiting_for_input', t => {
	t.false(
		ACTIVE_STATUSES.has('waiting_for_input'),
		'waiting_for_input is a stable status, not active',
	);
});

test('ACTIVE_STATUSES does not include ended', t => {
	t.false(ACTIVE_STATUSES.has('ended'), 'ended is a stable status, not active');
});

test('ACTIVE_STATUSES has exactly 3 statuses', t => {
	t.is(
		ACTIVE_STATUSES.size,
		3,
		'processing, running_tool, and compacting should be active statuses',
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
		'processing',
		'running_tool',
		'waiting_for_input',
		'waiting_for_approval',
		'compacting',
		'ended',
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

test('CLAUDE_STATUS_DISPLAY has correct icon for waiting_for_input', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_for_input.icon,
		'●',
		'waiting_for_input should show ● icon',
	);
	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_for_input.color,
		'green',
		'waiting_for_input should be green',
	);
});

test('CLAUDE_STATUS_DISPLAY has correct icon for waiting_for_approval', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_for_approval.icon,
		'!',
		'waiting_for_approval should show ! icon',
	);
	t.is(
		CLAUDE_STATUS_DISPLAY.waiting_for_approval.color,
		'red',
		'waiting_for_approval should be red',
	);
});

test('CLAUDE_STATUS_DISPLAY has correct icon for ended', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(CLAUDE_STATUS_DISPLAY.ended.icon, '●', 'ended should show ● icon');
	t.is(CLAUDE_STATUS_DISPLAY.ended.color, 'green', 'ended should be green');
});

test('CLAUDE_STATUS_DISPLAY has correct icon for compacting', async t => {
	const {CLAUDE_STATUS_DISPLAY} = await import('./types.ts');

	t.is(
		CLAUDE_STATUS_DISPLAY.compacting.icon,
		'◇',
		'compacting should show ◇ icon',
	);
	t.is(
		CLAUDE_STATUS_DISPLAY.compacting.color,
		'yellow',
		'compacting should be yellow',
	);
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

// ============================================================================
// findSpaceByStatusKey Tests
// ============================================================================

test('findSpaceByStatusKey matches main worktree by statusKey, not bare name', t => {
	const spaces = [
		{name: 'main', statusKey: 'pappa-chex-main'},
		{name: 'STA-123'},
	];
	// Should match the qualified status key
	t.is(findSpaceByStatusKey(spaces, 'pappa-chex-main'), 0);
	// Bare "main" should NOT match — prevents cross-repo collision
	t.is(findSpaceByStatusKey(spaces, 'main'), -1);
});

test('findSpaceByStatusKey matches issue worktrees by name (no statusKey)', t => {
	const spaces = [
		{name: 'main', statusKey: 'pappa-chex-main'},
		{name: 'STA-123'},
		{name: 'STA-456'},
	];
	t.is(findSpaceByStatusKey(spaces, 'STA-123'), 1);
	t.is(findSpaceByStatusKey(spaces, 'STA-456'), 2);
});

test('findSpaceByStatusKey returns -1 for unknown workspace', t => {
	const spaces = [
		{name: 'main', statusKey: 'pappa-chex-main'},
		{name: 'STA-123'},
	];
	t.is(findSpaceByStatusKey(spaces, 'other-repo-main'), -1);
	t.is(findSpaceByStatusKey(spaces, 'nonexistent'), -1);
});

test('findSpaceByStatusKey prevents cross-repo main branch collision', t => {
	// Two pappardelle instances managing different repos, both on branch "main"
	// Each should only match its own qualified status key
	const repoASpaces = [{name: 'main', statusKey: 'repo-a-main'}];
	const repoBSpaces = [{name: 'main', statusKey: 'repo-b-main'}];
	// Repo A status update should match repo A, not repo B
	t.is(findSpaceByStatusKey(repoASpaces, 'repo-a-main'), 0);
	t.is(findSpaceByStatusKey(repoBSpaces, 'repo-a-main'), -1);
	// Repo B status update should match repo B, not repo A
	t.is(findSpaceByStatusKey(repoBSpaces, 'repo-b-main'), 0);
	t.is(findSpaceByStatusKey(repoASpaces, 'repo-b-main'), -1);
});
