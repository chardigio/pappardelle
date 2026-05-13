import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'ava';
import type {ClaudeStatus, ClaudeSessionState} from './types.ts';
import {
	STABLE_STATUSES,
	ACTIVE_STATUSES,
	ACTIVE_STATUS_TIMEOUT,
} from './types.ts';
import {
	findSpaceByStatusKey,
	getClaudeStatusInfo,
	setClaudeStatus,
	watchStatuses,
} from './claude-status.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';

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
	writeFileSync(
		path.join(dir, `${workspace}.json`),
		JSON.stringify(state, null, 2),
	);
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

// ============================================================================
// Atomic write + defensive read tests
//
// Regression coverage for the file-race that produced "Unexpected end of JSON
// input" warnings: pappardelle reads status JSON on every fs.watch event, and
// the Claude Code hook (plus setClaudeStatus itself) was truncating-then-
// rewriting the same file. The fix is an atomic write (tmp file + rename) on
// the writer side and a silent fall-through to {status:'unknown'} on the
// reader side.
// ============================================================================

function withStatusDir(t: import('ava').ExecutionContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'papp-claude-status-'));
	const previous = process.env['PAPPARDELLE_STATUS_DIR'];
	process.env['PAPPARDELLE_STATUS_DIR'] = dir;
	t.teardown(() => {
		if (previous === undefined) {
			delete process.env['PAPPARDELLE_STATUS_DIR'];
		} else {
			process.env['PAPPARDELLE_STATUS_DIR'] = previous;
		}
		rmSync(dir, {recursive: true, force: true});
	});
	return dir;
}

test('setClaudeStatus is atomic — inode changes on each write (rename, not in-place truncate)', t => {
	const dir = withStatusDir(t);
	const workspace = 'STA-9001';
	const filePath = path.join(dir, `${workspace}.json`);

	setClaudeStatus(workspace, 'processing');
	const inodeBefore = statSync(filePath).ino;

	setClaudeStatus(workspace, 'running_tool');
	const inodeAfter = statSync(filePath).ino;

	// An atomic rename swaps the directory entry to a brand-new inode; an
	// in-place writeFileSync would truncate and reuse the same inode.
	// Note: this holds on ext4/APFS/HFS+ local filesystems (and is the case in
	// CI). On some NFS/SMB mounts and certain container overlayfs setups
	// inodes can be recycled — if this single assertion ever flakes on such a
	// host, the other checks below (no straggler tmps, parseable JSON, no
	// warn-level log) are the portable signals that the writer is atomic.
	t.not(
		inodeBefore,
		inodeAfter,
		'rewrite must replace the inode (atomic rename), not truncate in place',
	);
});

test('setClaudeStatus leaves no .tmp sibling files after a successful write', t => {
	const dir = withStatusDir(t);
	setClaudeStatus('STA-9002', 'processing');
	setClaudeStatus('STA-9002', 'running_tool');

	const stragglers = readdirSync(dir).filter(f => f.includes('.tmp.'));
	t.deepEqual(stragglers, [], 'rename should consume the temp file');
});

test('setClaudeStatus cleans up the tmp file when rename fails (no orphan on error)', t => {
	const dir = withStatusDir(t);
	const workspace = 'STA-9002b';

	// Create a directory where the final status file would go. renameSync of a
	// regular file onto a non-empty directory fails (EISDIR/ENOTDIR/ENOTEMPTY),
	// so the writer's try/catch must rm the tmp sibling before rethrowing.
	const targetAsDir = path.join(dir, `${workspace}.json`);
	mkdirSync(targetAsDir);
	writeFileSync(path.join(targetAsDir, 'placeholder'), 'x');

	t.throws(() => setClaudeStatus(workspace, 'processing'));

	const stragglers = readdirSync(dir).filter(f => f.includes('.tmp.'));
	t.deepEqual(
		stragglers,
		[],
		'failed write must not leave .tmp.<pid> orphans behind',
	);
});

test('setClaudeStatus produces parseable JSON at the final path', t => {
	const dir = withStatusDir(t);
	const workspace = 'STA-9003';
	setClaudeStatus(workspace, 'waiting_for_input', 'sess-1', 'Bash');

	const info = getClaudeStatusInfo(workspace);
	t.is(info.status, 'waiting_for_input');
	t.is(info.tool, 'Bash');

	// And sanity-check the on-disk shape directly.
	const raw = readFileSync(path.join(dir, `${workspace}.json`), 'utf-8');
	const parsed = JSON.parse(raw) as ClaudeSessionState;
	t.is(parsed.status, 'waiting_for_input');
	t.is(parsed.workspaceName, workspace);
});

test('getClaudeStatusInfo returns {status:"unknown"} for an empty file (mid-truncate race)', t => {
	const dir = withStatusDir(t);
	const workspace = 'STA-9004';
	writeFileSync(path.join(dir, `${workspace}.json`), '');

	// The truncate-then-write race used to bubble "Unexpected end of JSON
	// input" up to the TUI. Defensive read should swallow that and report
	// unknown.
	t.deepEqual(getClaudeStatusInfo(workspace), {status: 'unknown'});
});

test('getClaudeStatusInfo returns {status:"unknown"} for malformed JSON without throwing', t => {
	const dir = withStatusDir(t);
	const workspace = 'STA-9005';
	writeFileSync(path.join(dir, `${workspace}.json`), '{not really json');

	t.notThrows(() => getClaudeStatusInfo(workspace));
	t.deepEqual(getClaudeStatusInfo(workspace), {status: 'unknown'});
});

test('watchStatuses ignores .tmp.<pid> filesystem events (only .json events reach the callback)', async t => {
	const dir = withStatusDir(t);
	const callbackArgs: string[] = [];

	const stop = watchStatuses(workspaceName => {
		callbackArgs.push(workspaceName);
	});
	t.teardown(stop);

	// Two writes — each creates a .tmp.<pid> sibling, renames it onto the .json
	// target. The watcher should never surface .tmp.<pid> filename events.
	setClaudeStatus('STA-9010', 'processing');
	setClaudeStatus('STA-9010', 'running_tool');

	// fs.watch delivers events on the next tick; give it a beat to flush.
	await new Promise<void>(resolve => setTimeout(resolve, 50));

	t.true(
		callbackArgs.every(ws => !ws.includes('.tmp.')),
		`callback received a .tmp.<pid> event it should have filtered out: ${JSON.stringify(callbackArgs)}`,
	);
});

test('getClaudeStatusInfo parse failures do NOT surface a warn-level log to the TUI', t => {
	const dir = withStatusDir(t);
	const workspace = 'STA-9006';
	writeFileSync(path.join(dir, `${workspace}.json`), '');

	clearRecentErrors();
	getClaudeStatusInfo(workspace);
	const surfaced = getRecentErrors().filter(
		e => e.component === 'claude-status',
	);

	// warn/error entries get pushed to the in-memory buffer that powers the
	// "Errors (N)" pane. A parse failure on the status file is a known
	// transient and must not show up there.
	t.deepEqual(
		surfaced,
		[],
		'parse failures must stay at debug level (file logs only, no TUI noise)',
	);
});
