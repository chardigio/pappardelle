import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {
	claudeStatusFile,
	testState,
	writeClaudeStatus,
} from '../test/helpers/state.ts';
import {waitUntil, watcherReady} from '../test/helpers/wait.ts';
import type {ClaudeStatus, ClaudeSessionState} from './claude-status.ts';
import {
	STABLE_STATUSES,
	ACTIVE_STATUSES,
	ACTIVE_STATUS_TIMEOUT,
} from './claude-status.ts';
import {
	findSpaceByStatusKey,
	hookStatusKey,
	parseSessionState,
} from './claude-status.ts';
import {createStateDaos} from './state-daos.ts';

// ============================================================================
// Helper Functions
// ============================================================================

const session = (
	workspaceName: string,
	status: ClaudeStatus,
	rest: Partial<ClaudeSessionState> = {},
): ClaudeSessionState => ({
	sessionId: 'test-session',
	workspaceName,
	status,
	lastUpdate: Date.now(),
	...rest,
});

// ============================================================================
// STABLE_STATUSES Tests
// ============================================================================

test('STABLE_STATUSES includes waiting_for_input', () => {
	expect(
		STABLE_STATUSES.has('waiting_for_input'),
		'waiting_for_input should be a stable status',
	).toBe(true);
});

test('STABLE_STATUSES includes waiting_for_approval', () => {
	expect(
		STABLE_STATUSES.has('waiting_for_approval'),
		'waiting_for_approval should be a stable status',
	).toBe(true);
});

test('STABLE_STATUSES includes ended', () => {
	expect(STABLE_STATUSES.has('ended'), 'ended should be a stable status').toBe(
		true,
	);
});

test('STABLE_STATUSES includes error', () => {
	expect(
		STABLE_STATUSES.has('error'),
		'error should be a stable status (persists until resolved)',
	).toBe(true);
});

test('STABLE_STATUSES does not include processing', () => {
	expect(
		STABLE_STATUSES.has('processing'),
		'processing is an active status, not stable',
	).toBe(false);
});

test('STABLE_STATUSES does not include running_tool', () => {
	expect(
		STABLE_STATUSES.has('running_tool'),
		'running_tool is an active status, not stable',
	).toBe(false);
});

test('STABLE_STATUSES does not include compacting', () => {
	expect(
		STABLE_STATUSES.has('compacting'),
		'compacting is an active status, not stable',
	).toBe(false);
});

test('STABLE_STATUSES does not include unknown', () => {
	expect(
		STABLE_STATUSES.has('unknown'),
		'unknown is a fallback, not a real status',
	).toBe(false);
});

// ============================================================================
// ACTIVE_STATUSES Tests
// ============================================================================

test('ACTIVE_STATUSES includes processing', () => {
	expect(
		ACTIVE_STATUSES.has('processing'),
		'processing should be an active status',
	).toBe(true);
});

test('ACTIVE_STATUSES includes running_tool', () => {
	expect(
		ACTIVE_STATUSES.has('running_tool'),
		'running_tool should be an active status',
	).toBe(true);
});

test('ACTIVE_STATUSES includes compacting', () => {
	expect(
		ACTIVE_STATUSES.has('compacting'),
		'compacting should be an active status',
	).toBe(true);
});

test('ACTIVE_STATUSES does not include waiting_for_input', () => {
	expect(
		ACTIVE_STATUSES.has('waiting_for_input'),
		'waiting_for_input is a stable status, not active',
	).toBe(false);
});

test('ACTIVE_STATUSES does not include ended', () => {
	expect(
		ACTIVE_STATUSES.has('ended'),
		'ended is a stable status, not active',
	).toBe(false);
});

test('ACTIVE_STATUSES has exactly 3 statuses', () => {
	expect(
		ACTIVE_STATUSES.size,
		'processing, running_tool, and compacting should be active statuses',
	).toBe(3);
});

// ============================================================================
// ACTIVE_STATUS_TIMEOUT Tests
// ============================================================================

test('ACTIVE_STATUS_TIMEOUT is 10 minutes', () => {
	const tenMinutesMs = 10 * 60 * 1000;
	expect(
		ACTIVE_STATUS_TIMEOUT,
		'Active statuses should become stale after 10 minutes',
	).toBe(tenMinutesMs);
});

// ============================================================================
// Complete Status Coverage Test
// ============================================================================

test('All ClaudeStatus types are categorized', () => {
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

		expect(
			isInStable || isInActive,
			`Status '${status}' should be in either STABLE_STATUSES or ACTIVE_STATUSES`,
		).toBe(true);

		expect(
			isInStable && isInActive,
			`Status '${status}' should not be in both STABLE_STATUSES and ACTIVE_STATUSES`,
		).toBe(false);
	}
});

// ============================================================================
// findSpaceByStatusKey Tests
// ============================================================================

test('findSpaceByStatusKey matches main worktree by statusKey, not bare name', () => {
	const spaces = [
		{name: 'main', statusKey: 'pappa-chex-main'},
		{name: 'STA-123'},
	];
	// Should match the qualified status key
	expect(findSpaceByStatusKey(spaces, 'pappa-chex-main')).toBe(0);
	// Bare "main" should NOT match — prevents cross-repo collision
	expect(findSpaceByStatusKey(spaces, 'main')).toBe(-1);
});

test('findSpaceByStatusKey matches issue worktrees by name (no statusKey)', () => {
	const spaces = [
		{name: 'main', statusKey: 'pappa-chex-main'},
		{name: 'STA-123'},
		{name: 'STA-456'},
	];
	expect(findSpaceByStatusKey(spaces, 'STA-123')).toBe(1);
	expect(findSpaceByStatusKey(spaces, 'STA-456')).toBe(2);
});

test('findSpaceByStatusKey returns -1 for unknown workspace', () => {
	const spaces = [
		{name: 'main', statusKey: 'pappa-chex-main'},
		{name: 'STA-123'},
	];
	expect(findSpaceByStatusKey(spaces, 'other-repo-main')).toBe(-1);
	expect(findSpaceByStatusKey(spaces, 'nonexistent')).toBe(-1);
});

test('findSpaceByStatusKey prevents cross-repo main branch collision', () => {
	// Two pappardelle instances managing different repos, both on branch "main"
	// Each should only match its own qualified status key
	const repoASpaces = [{name: 'main', statusKey: 'repo-a-main'}];
	const repoBSpaces = [{name: 'main', statusKey: 'repo-b-main'}];
	// Repo A status update should match repo A, not repo B
	expect(findSpaceByStatusKey(repoASpaces, 'repo-a-main')).toBe(0);
	expect(findSpaceByStatusKey(repoBSpaces, 'repo-a-main')).toBe(-1);
	// Repo B status update should match repo B, not repo A
	expect(findSpaceByStatusKey(repoBSpaces, 'repo-b-main')).toBe(0);
	expect(findSpaceByStatusKey(repoASpaces, 'repo-b-main')).toBe(-1);
});

test('hookStatusKey qualifies a space key or main branch by repo, flattening slashes', () => {
	expect(hookStatusKey('stardust-labs', 'STA-1')).toBe('stardust-labs-STA-1');
	expect(hookStatusKey('stardust-labs', 'master')).toBe('stardust-labs-master');
	expect(hookStatusKey('repo', 'alice/STA-1')).toBe('repo-alice-STA-1');
});

test('a status record needs the fields the hook always writes, and a status it can report', () => {
	const state = session('STA-1', 'running_tool', {
		currentTool: 'Bash',
		event: 'PreToolUse',
		cwd: '/work',
	});
	expect(parseSessionState(JSON.stringify(state))).toStrictEqual(state);
	expect(
		parseSessionState(
			JSON.stringify(session('STA-1', 'ended', {lastUpdate: 5})),
		),
	).toStrictEqual({
		sessionId: 'test-session',
		workspaceName: 'STA-1',
		status: 'ended',
		lastUpdate: 5,
	});
	for (const broken of [
		{...state, sessionId: undefined},
		{...state, workspaceName: 7},
		{...state, status: 'working'},
		{...state, lastUpdate: '5'},
		{...state, currentTool: 7},
		{...state, event: null},
		{...state, cwd: false},
		null,
		[],
	]) {
		expect(() => parseSessionState(JSON.stringify(broken))).toThrow();
	}

	expect(() => parseSessionState('{')).toThrow();
});

// ============================================================================
// What every status store does, wherever the hook reported to
// ============================================================================

contractTest('a key nobody reported under is unknown', async s => {
	expect(await s.daos.claudeStatus.read('STA-1')).toStrictEqual({
		status: 'unknown',
	});
	expect(await s.daos.claudeStatus.readState('STA-1')).toStrictEqual({
		kind: 'none',
	});
});

contractTest('a reported status is read back, with its tool', async s => {
	const state = session('STA-1', 'running_tool', {
		currentTool: 'Bash',
		event: 'PreToolUse',
		cwd: '/work/STA-1',
	});
	await writeClaudeStatus(s, state);
	expect(await s.daos.claudeStatus.read('STA-1')).toStrictEqual({
		status: 'running_tool',
		tool: 'Bash',
	});
	expect(await s.daos.claudeStatus.readState('STA-1')).toStrictEqual({
		kind: 'state',
		state,
	});
});

contractTest(
	'a later report replaces the record, including fields it no longer reports',
	async s => {
		await writeClaudeStatus(
			s,
			session('STA-1', 'running_tool', {currentTool: 'Bash', cwd: '/work'}),
		);
		const state = session('STA-1', 'waiting_for_input');
		await writeClaudeStatus(s, state);
		expect(await s.daos.claudeStatus.read('STA-1')).toStrictEqual({
			status: 'waiting_for_input',
			tool: undefined,
		});
		expect(await s.daos.claudeStatus.readState('STA-1')).toStrictEqual({
			kind: 'state',
			state,
		});
	},
);

contractTest(
	'an active status goes unknown after ten minutes without a report, a stable one never does',
	async s => {
		const stale = Date.now() - ACTIVE_STATUS_TIMEOUT - 1;
		for (const status of ACTIVE_STATUSES) {
			await writeClaudeStatus(s, session('STA-1', status, {lastUpdate: stale}));
			expect(await s.daos.claudeStatus.read('STA-1')).toStrictEqual({
				status: 'unknown',
			});
			await writeClaudeStatus(
				s,
				session('STA-1', status, {lastUpdate: stale + 60_000}),
			);
			expect(await s.daos.claudeStatus.read('STA-1')).toStrictEqual({
				status,
				tool: undefined,
			});
		}

		await writeClaudeStatus(
			s,
			session('STA-1', 'waiting_for_input', {lastUpdate: 0}),
		);
		expect(await s.daos.claudeStatus.read('STA-1')).toStrictEqual({
			status: 'waiting_for_input',
			tool: undefined,
		});
		// The record itself is not aged: `pappardelle spaces` reports it raw.
		const stored = await s.daos.claudeStatus.readState('STA-1');
		expect(stored.kind === 'state' && stored.state.lastUpdate).toBe(0);
	},
);

contractTest(
	'the bare status name is read only while nothing is reported under the qualified one',
	async s => {
		const dao = s.daos.claudeStatus;
		expect(await dao.readableKey('repo', 'STA-1')).toBe('repo-STA-1');
		await writeClaudeStatus(s, session('STA-1', 'processing'));
		expect(await dao.readableKey('repo', 'STA-1')).toBe('STA-1');
		await writeClaudeStatus(s, session('repo-STA-1', 'processing'));
		expect(await dao.readableKey('repo', 'STA-1')).toBe('repo-STA-1');
	},
);

contractTest(
	'a branch with a slash is read under its flattened key',
	async s => {
		await writeClaudeStatus(s, session('repo-alice-STA-1', 'processing'));
		const key = await s.daos.claudeStatus.readableKey('repo', 'alice/STA-1');
		expect(await s.daos.claudeStatus.read(key)).toStrictEqual({
			status: 'processing',
			tool: undefined,
		});
	},
);

contractTest('watch reports the key that changed', async s => {
	const dao = s.daos.claudeStatus;
	await writeClaudeStatus(s, session('STA-1', 'processing'));
	await writeClaudeStatus(s, session('STA-2', 'processing'));
	const reported: string[] = [];
	const stop = dao.watch(key => reported.push(key));
	teardown(stop);
	await watcherReady();
	// On macOS a new watch can still get the late events of writes made before
	// it started. They come ahead of a later write's events, so once this
	// write is reported none are left to arrive.
	await writeClaudeStatus(s, session('STA-0', 'processing'));
	await waitUntil(() => reported.includes('STA-0'), 'the first write');
	reported.length = 0;
	await writeClaudeStatus(s, session('STA-2', 'waiting_for_input'));
	await waitUntil(() => reported.includes('STA-2'), 'a status change');
	await writeClaudeStatus(s, session('STA-3', 'ended'));
	await waitUntil(() => reported.includes('STA-3'), 'a status change');
	expect(reported.includes('STA-1')).toBe(false);
	stop();
	const before = reported.length;
	await writeClaudeStatus(s, session('STA-1', 'ended'));
	await delay(100);
	expect(reported.length).toBe(before);
});

contractTest(
	'waitForChange resolves on a report, and otherwise when its time is up',
	async s => {
		const dao = s.daos.claudeStatus;
		await writeClaudeStatus(s, session('STA-1', 'processing'));
		const started = performance.now();
		const waiting = dao.waitForChange(5000);
		await delay(50);
		await writeClaudeStatus(s, session('STA-1', 'ended'));
		await waiting;
		expect(performance.now() - started < 2000).toBe(true);
		// On macOS a file watch made just after the report can still get that
		// report's late events (a status file is a write and a rename), so a
		// wait can end early. A caller only reads again on a wake, so an extra
		// wake does no harm: the contract is that a quiet store lets a wait run
		// out its time, not that the first wait after a report does.
		let ranOut = false;
		for (let attempt = 0; attempt < 20 && !ranOut; attempt++) {
			const idle = performance.now();
			await dao.waitForChange(100);
			ranOut = performance.now() - idle >= 90;
		}

		expect(ranOut).toBe(true);
	},
);

// With the flag on a status file is still read where the daemon holds no
// record: the hook wrote it while the flag was off.
contractTest(
	'a status file that is not a status cannot be read, and is not reported as absent',
	async s => {
		mkdirSync(path.dirname(claudeStatusFile(s, 'STA-1')), {recursive: true});
		writeFileSync(claudeStatusFile(s, 'STA-1'), '{');
		expect(await s.daos.claudeStatus.read('STA-1')).toBe(null);
		expect(await s.daos.claudeStatus.readState('STA-1')).toStrictEqual({
			kind: 'unreadable',
		});
	},
);

// ============================================================================
// Status files (experimental.sqliteState off)
// ============================================================================

test('a removed status file is unknown again, and the bare name is read again', async () => {
	const s = testState({sqlite: false});
	const dao = s.daos.claudeStatus;
	await writeClaudeStatus(s, session('STA-1', 'ended'));
	await writeClaudeStatus(s, session('repo-STA-1', 'ended'));
	rmSync(claudeStatusFile(s, 'repo-STA-1'));
	expect(await dao.read('repo-STA-1')).toStrictEqual({status: 'unknown'});
	expect(await dao.readState('repo-STA-1')).toStrictEqual({kind: 'none'});
	expect(await dao.readableKey('repo', 'STA-1')).toBe('STA-1');
});

// ============================================================================
// The status daemon (experimental.sqliteState on)
// ============================================================================

test('with the flag on, the newer of the daemon’s record and a status file is read', async () => {
	const files = testState({sqlite: false});
	const s = testState({sqlite: true, stateDir: files.stateDir});
	const at = Date.now();

	// Written while the flag was off, after the daemon's last event.
	await writeClaudeStatus(
		s,
		session('repo-STA-1', 'running_tool', {lastUpdate: at - 2000}),
	);
	await writeClaudeStatus(
		files,
		session('repo-STA-1', 'waiting_for_input', {lastUpdate: at - 1000}),
	);
	expect(await s.daos.claudeStatus.readState('repo-STA-1')).toMatchObject({
		kind: 'state',
		state: {status: 'waiting_for_input'},
	});

	// The file is now the older of the two: the hook reached the daemon and
	// has not deleted it yet.
	await writeClaudeStatus(
		s,
		session('repo-STA-1', 'processing', {lastUpdate: at}),
	);
	expect(await s.daos.claudeStatus.readState('repo-STA-1')).toMatchObject({
		kind: 'state',
		state: {status: 'processing'},
	});

	await writeClaudeStatus(
		files,
		session('repo-STA-1', 'ended', {lastUpdate: at}),
	);
	expect(
		await s.daos.claudeStatus.readState('repo-STA-1'),
		'the status file is read when the two are as recent',
	).toMatchObject({kind: 'state', state: {status: 'ended'}});
});

test('with the flag on, a status the daemon does not hold is read from its status file, under the bare key too', async () => {
	const files = testState({sqlite: false});
	const s = testState({sqlite: true, stateDir: files.stateDir});
	await writeClaudeStatus(files, session('STA-2', 'waiting_for_input'));
	expect(await s.daos.claudeStatus.readableKey('repo', 'STA-2')).toBe('STA-2');
	expect(await s.daos.claudeStatus.read('STA-2')).toMatchObject({
		status: 'waiting_for_input',
	});
});

test('with the flag on and no daemon, every key reads as never reported and a wait for a change runs out its time', async () => {
	const {stateDir} = testState({sqlite: false});
	const {claudeStatus, disconnectStatusDaemon} = createStateDaos({
		repo: 'repo',
		stateDir,
		sqlite: true,
	});
	teardown(disconnectStatusDaemon);
	expect(await claudeStatus.readState('repo-STA-1')).toStrictEqual({
		kind: 'none',
	});
	expect(await claudeStatus.read('repo-STA-1')).toStrictEqual({
		status: 'unknown',
	});
	expect(await claudeStatus.readableKey('repo', 'STA-1')).toBe('repo-STA-1');
	const started = performance.now();
	await claudeStatus.waitForChange(100);
	expect(performance.now() - started >= 90).toBe(true);
});
