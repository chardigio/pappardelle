import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {testState} from '../test/helpers/state.ts';
import {waitForAgentStart} from './agent-start.ts';
import type {ClaudeSessionState} from './claude-status.ts';

function fixture(t: ExecutionContext) {
	const {daos, stateDir: dir} = testState(t);
	const statusKey = 'test-repo-TEST-1';
	const worktree = path.join(dir, '.worktrees', 'test-repo', 'TEST-1');
	const since = Date.now();
	const write = async (
		status: Pick<ClaudeSessionState, 'event' | 'cwd' | 'lastUpdate'>,
	) =>
		daos.claudeStatus.write({
			sessionId: 'session',
			workspaceName: statusKey,
			status: 'waiting_for_input',
			...status,
		});

	const wait = async (timeoutMs = 0) =>
		waitForAgentStart({
			claudeStatus: daos.claudeStatus,
			statusKey,
			worktree,
			since,
			timeoutMs,
			pollMs: 20,
		});
	return {dir, worktree, since, write, wait};
}

test('a fresh SessionStart from the worktree confirms the agent', async t => {
	const f = fixture(t);
	await f.write({event: 'SessionStart', cwd: f.worktree, lastUpdate: f.since});
	t.true(await f.wait());
});

test('a SessionStart from a subdirectory of the worktree counts', async t => {
	const f = fixture(t);
	await f.write({
		event: 'SessionStart',
		cwd: path.join(f.worktree, 'packages', 'app'),
		lastUpdate: f.since,
	});
	t.true(await f.wait());
});

test('a later event that replaced SessionStart counts', async t => {
	const f = fixture(t);
	await f.write({event: 'Stop', cwd: f.worktree, lastUpdate: f.since});
	t.true(await f.wait());
});

test('a status written before the open does not count', async t => {
	const f = fixture(t);
	await f.write({
		event: 'SessionStart',
		cwd: f.worktree,
		lastUpdate: f.since - 1,
	});
	t.false(await f.wait());
});

test("another repo's space with the same key does not count", async t => {
	const f = fixture(t);
	await f.write({
		event: 'SessionStart',
		cwd: path.join(f.dir, '.worktrees', 'test-repo-other', 'TEST-1'),
		lastUpdate: f.since,
	});
	t.false(await f.wait());
});

test('an ended agent does not count', async t => {
	const f = fixture(t);
	await f.write({event: 'SessionEnd', cwd: f.worktree, lastUpdate: f.since});
	t.false(await f.wait());
});

test('no status file times out', async t => {
	const f = fixture(t);
	t.false(await f.wait());
});

test('an agent that starts during the wait is confirmed', async t => {
	const f = fixture(t);
	setTimeout(() => {
		void f.write({
			event: 'SessionStart',
			cwd: f.worktree,
			lastUpdate: Date.now(),
		});
	}, 100);
	t.true(await f.wait(5000));
});
