import path from 'node:path';
import {test, expect} from 'bun:test';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {waitForAgentStart} from './agent-start.ts';
import type {ClaudeSessionState} from './claude-status.ts';

function fixture() {
	const state = testState();
	const {daos, stateDir: dir} = state;
	const statusKey = 'test-repo-TEST-1';
	const worktree = path.join(dir, '.worktrees', 'test-repo', 'TEST-1');
	const since = Date.now();
	const write = async (
		status: Pick<ClaudeSessionState, 'event' | 'cwd' | 'lastUpdate'>,
	) =>
		writeClaudeStatus(state, {
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

test('a fresh SessionStart from the worktree confirms the agent', async () => {
	const f = fixture();
	await f.write({event: 'SessionStart', cwd: f.worktree, lastUpdate: f.since});
	expect(await f.wait()).toBe(true);
});

test('a SessionStart from a subdirectory of the worktree counts', async () => {
	const f = fixture();
	await f.write({
		event: 'SessionStart',
		cwd: path.join(f.worktree, 'packages', 'app'),
		lastUpdate: f.since,
	});
	expect(await f.wait()).toBe(true);
});

test('a later event that replaced SessionStart counts', async () => {
	const f = fixture();
	await f.write({event: 'Stop', cwd: f.worktree, lastUpdate: f.since});
	expect(await f.wait()).toBe(true);
});

test('a status written before the open does not count', async () => {
	const f = fixture();
	await f.write({
		event: 'SessionStart',
		cwd: f.worktree,
		lastUpdate: f.since - 1,
	});
	expect(await f.wait()).toBe(false);
});

test("another repo's space with the same key does not count", async () => {
	const f = fixture();
	await f.write({
		event: 'SessionStart',
		cwd: path.join(f.dir, '.worktrees', 'test-repo-other', 'TEST-1'),
		lastUpdate: f.since,
	});
	expect(await f.wait()).toBe(false);
});

test('an ended agent does not count', async () => {
	const f = fixture();
	await f.write({event: 'SessionEnd', cwd: f.worktree, lastUpdate: f.since});
	expect(await f.wait()).toBe(false);
});

test('no status file times out', async () => {
	const f = fixture();
	expect(await f.wait()).toBe(false);
});

test('an agent that starts during the wait is confirmed', async () => {
	const f = fixture();
	setTimeout(() => {
		void f.write({
			event: 'SessionStart',
			cwd: f.worktree,
			lastUpdate: Date.now(),
		});
	}, 100);
	expect(await f.wait(5000)).toBe(true);
});
