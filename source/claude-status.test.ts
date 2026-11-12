import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {waitUntil} from '../test/helpers/wait.ts';
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

// ============================================================================
// Helper Functions
// ============================================================================

const statusDir = (s: TestState) => path.join(s.stateDir, 'claude-status');

const statusFile = (s: TestState, key: string) =>
	path.join(statusDir(s), `${key}.json`);

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

/** A status file as an agent whose hook does not use the database leaves it. */
function writeStatusFile(s: TestState, state: ClaudeSessionState): void {
	mkdirSync(statusDir(s), {recursive: true});
	writeFileSync(
		statusFile(s, state.workspaceName),
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

test('hookStatusKey qualifies a space key or main branch by repo, flattening slashes', t => {
	t.is(hookStatusKey('stardust-labs', 'STA-1'), 'stardust-labs-STA-1');
	t.is(hookStatusKey('stardust-labs', 'master'), 'stardust-labs-master');
	t.is(hookStatusKey('repo', 'alice/STA-1'), 'repo-alice-STA-1');
});

test('a status record needs the fields the hook always writes, and a status it can report', t => {
	const state = session('STA-1', 'running_tool', {
		currentTool: 'Bash',
		event: 'PreToolUse',
		cwd: '/work',
	});
	t.deepEqual(parseSessionState(JSON.stringify(state)), state);
	t.deepEqual(
		parseSessionState(
			JSON.stringify(session('STA-1', 'ended', {lastUpdate: 5})),
		),
		{
			sessionId: 'test-session',
			workspaceName: 'STA-1',
			status: 'ended',
			lastUpdate: 5,
		},
	);
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
		t.throws(() => parseSessionState(JSON.stringify(broken)));
	}

	t.throws(() => parseSessionState('{'));
});

// ============================================================================
// What every status store does, whichever way it is stored
// ============================================================================

contractTest('a key nobody reported under is unknown', async (t, s) => {
	t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {status: 'unknown'});
	t.deepEqual(s.daos.claudeStatus.readState('STA-1'), {kind: 'none'});
});

contractTest('a written status is read back, with its tool', async (t, s) => {
	const state = session('STA-1', 'running_tool', {
		currentTool: 'Bash',
		event: 'PreToolUse',
		cwd: '/work/STA-1',
	});
	await s.daos.claudeStatus.write(state);
	t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {
		status: 'running_tool',
		tool: 'Bash',
	});
	t.deepEqual(s.daos.claudeStatus.readState('STA-1'), {kind: 'state', state});
	t.deepEqual(
		JSON.parse(readFileSync(statusFile(s, 'STA-1'), 'utf8')) as unknown,
		state,
	);
});

contractTest(
	'a later write replaces the record, including fields it no longer reports',
	async (t, s) => {
		await s.daos.claudeStatus.write(
			session('STA-1', 'running_tool', {currentTool: 'Bash', cwd: '/work'}),
		);
		const state = session('STA-1', 'waiting_for_input');
		await s.daos.claudeStatus.write(state);
		t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {
			status: 'waiting_for_input',
			tool: undefined,
		});
		t.deepEqual(s.daos.claudeStatus.readState('STA-1'), {
			kind: 'state',
			state,
		});
	},
);

contractTest(
	'a status file written by a hook without the database is read',
	async (t, s) => {
		const state = session('STA-1', 'waiting_for_approval', {
			currentTool: 'AskUserQuestion',
		});
		writeStatusFile(s, state);
		t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {
			status: 'waiting_for_approval',
			tool: 'AskUserQuestion',
		});
		t.deepEqual(s.daos.claudeStatus.readState('STA-1'), {
			kind: 'state',
			state,
		});
		const later = session('STA-1', 'ended');
		writeStatusFile(s, later);
		t.deepEqual(s.daos.claudeStatus.readState('STA-1'), {
			kind: 'state',
			state: later,
		});
	},
);

contractTest('a removed status file is unknown again', async (t, s) => {
	await s.daos.claudeStatus.write(session('STA-1', 'ended'));
	rmSync(statusFile(s, 'STA-1'));
	t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {status: 'unknown'});
	t.deepEqual(s.daos.claudeStatus.readState('STA-1'), {kind: 'none'});
});

contractTest(
	'an active status goes unknown after ten minutes without a report, a stable one never does',
	async (t, s) => {
		const stale = Date.now() - ACTIVE_STATUS_TIMEOUT - 1;
		for (const status of ACTIVE_STATUSES) {
			await s.daos.claudeStatus.write(
				session('STA-1', status, {lastUpdate: stale}),
			);
			t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {
				status: 'unknown',
			});
			await s.daos.claudeStatus.write(
				session('STA-1', status, {lastUpdate: stale + 60_000}),
			);
			t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {
				status,
				tool: undefined,
			});
		}

		await s.daos.claudeStatus.write(
			session('STA-1', 'waiting_for_input', {lastUpdate: 0}),
		);
		t.deepEqual(await s.daos.claudeStatus.read('STA-1'), {
			status: 'waiting_for_input',
			tool: undefined,
		});
		// The record itself is not aged: `pappardelle spaces` reports it raw.
		const stored = s.daos.claudeStatus.readState('STA-1');
		t.is(stored.kind === 'state' && stored.state.lastUpdate, 0);
	},
);

contractTest(
	'a status file that is not a status cannot be read, and is not reported as absent',
	async (t, s) => {
		mkdirSync(statusDir(s), {recursive: true});
		writeFileSync(statusFile(s, 'STA-1'), '{');
		t.is(await s.daos.claudeStatus.read('STA-1'), null);
		t.deepEqual(s.daos.claudeStatus.readState('STA-1'), {kind: 'unreadable'});
	},
);

contractTest(
	'the bare status name is read only while the qualified one is missing',
	async (t, s) => {
		const dao = s.daos.claudeStatus;
		t.is(dao.readableKey('repo', 'STA-1'), 'repo-STA-1');
		await dao.write(session('STA-1', 'processing'));
		t.is(dao.readableKey('repo', 'STA-1'), 'STA-1');
		await dao.write(session('repo-STA-1', 'processing'));
		t.is(dao.readableKey('repo', 'STA-1'), 'repo-STA-1');
		rmSync(statusFile(s, 'repo-STA-1'));
		t.is(dao.readableKey('repo', 'STA-1'), 'STA-1');
	},
);

contractTest('a slash in a branch name stays out of the path', async (t, s) => {
	const key = hookStatusKey('repo', 'alice/STA-1');
	await s.daos.claudeStatus.write(session(key, 'processing'));
	t.is(s.daos.claudeStatus.readableKey('repo', 'alice/STA-1'), key);
	t.deepEqual(readdirSync(statusDir(s)), ['repo-alice-STA-1.json']);
});

contractTest('writes leave nothing beside the status files', async (t, s) => {
	await s.daos.claudeStatus.write(session('STA-1', 'processing'));
	await s.daos.claudeStatus.write(session('STA-1', 'running_tool'));
	await s.daos.claudeStatus.write(session('STA-2', 'ended'));
	t.deepEqual(readdirSync(statusDir(s)).sort(), ['STA-1.json', 'STA-2.json']);
});

contractTest(
	'a write replaces the file by rename, so a reader never sees half of it',
	async (t, s) => {
		await s.daos.claudeStatus.write(session('STA-1', 'processing'));
		const before = statSync(statusFile(s, 'STA-1')).ino;
		await s.daos.claudeStatus.write(session('STA-1', 'running_tool'));
		// An in-place write would truncate and keep the inode.
		t.not(statSync(statusFile(s, 'STA-1')).ino, before);
	},
);

contractTest(
	'a write that cannot replace the file fails and leaves no temp file',
	async (t, s) => {
		// A rename onto a non-empty directory fails.
		mkdirSync(path.join(statusFile(s, 'STA-1'), 'in-the-way'), {
			recursive: true,
		});
		await t.throwsAsync(
			s.daos.claudeStatus.write(session('STA-1', 'processing')),
		);
		t.deepEqual(readdirSync(statusDir(s)), ['STA-1.json']);
	},
);

contractTest('watch reports the key that changed', async (t, s) => {
	const dao = s.daos.claudeStatus;
	await dao.write(session('STA-1', 'processing'));
	await dao.write(session('STA-2', 'processing'));
	const reported: string[] = [];
	const stop = dao.watch(key => reported.push(key));
	t.teardown(stop);
	// A write can otherwise precede filesystem watch registration.
	await delay(0);
	await dao.write(session('STA-2', 'waiting_for_input'));
	await waitUntil(() => reported.includes('STA-2'), 'a status change');
	await dao.write(session('STA-3', 'ended'));
	await waitUntil(() => reported.includes('STA-3'), 'a status change');
	t.false(reported.includes('STA-1'));
	stop();
	const before = reported.length;
	await dao.write(session('STA-1', 'ended'));
	await delay(100);
	t.is(reported.length, before);
});

contractTest(
	'waitForChange resolves on a write, and otherwise when its time is up',
	async (t, s) => {
		const dao = s.daos.claudeStatus;
		await dao.write(session('STA-1', 'processing'));
		const started = performance.now();
		const waiting = dao.waitForChange(5000);
		await delay(50);
		await dao.write(session('STA-1', 'ended'));
		await waiting;
		t.true(performance.now() - started < 2000);
		const idle = performance.now();
		await dao.waitForChange(100);
		t.true(performance.now() - idle >= 90);
	},
);

test('the two stores leave the same status files for the same writes', async t => {
	const history: ClaudeSessionState[] = [
		session('repo-STA-1', 'running_tool', {
			currentTool: 'Bash',
			event: 'PreToolUse',
			cwd: '/work/STA-1',
			lastUpdate: 1000,
		}),
		session('repo-STA-2', 'waiting_for_approval', {
			currentTool: 'AskUserQuestion',
			lastUpdate: 2000,
		}),
		session('repo-STA-1', 'waiting_for_input', {
			event: 'Stop',
			lastUpdate: 3000,
		}),
	];
	const files = async (sqlite: boolean) => {
		const s = testState(t, {sqlite});
		for (const state of history) await s.daos.claudeStatus.write(state);
		return Object.fromEntries(
			readdirSync(statusDir(s))
				.sort()
				.map(name => [
					name,
					readFileSync(path.join(statusDir(s), name), 'utf8'),
				]),
		);
	};

	const json = await files(false);
	t.deepEqual(Object.keys(json), ['repo-STA-1.json', 'repo-STA-2.json']);
	t.deepEqual(await files(true), json);
});
