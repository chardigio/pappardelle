import path from 'node:path';
import {test, expect} from 'bun:test';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {waitForAgentStart} from './agent-start.ts';
import type {ClaudeSessionState} from './claude-status.ts';
import {
	parseStatusPane,
	type ProgramStatusSnapshot,
	type StatusPane,
} from './program-status-monitor.ts';
import {newSpaceIdentity} from './space-identity.ts';
import type {OuterTmuxRunner} from './tmux.ts';

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

function oscFixture(
	paneState: {dead?: boolean; marker?: string; command?: string} = {},
) {
	const state = testState();
	const issueKey = 'TEST-1';
	const worktree = path.join(
		state.stateDir,
		'.worktrees',
		state.repo,
		issueKey,
	);
	const identity = newSpaceIdentity({
		repo: state.repo,
		key: issueKey,
		worktreePath: worktree,
		socket: 'pappardelle_inner',
	});
	const marker = paneState.marker ?? '42.abc';
	const deadFlag = paneState.dead ? '1' : '0';
	const command = paneState.command ?? 'agy';
	const paneLine = `%5\t42\t${deadFlag}\t1\t${marker}`;
	const pane = parseStatusPane(paneLine, identity.tmux.socket)!;
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-panes') {
			return {status: 0, stdout: `11\t%5\t${paneLine}\t${command}\n`};
		}

		return {status: 1, stdout: ''};
	};
	return {state, issueKey, worktree, identity, pane, runner};
}

function oscSnapshot(
	key: string,
	pane: StatusPane,
	overrides: Partial<ProgramStatusSnapshot> = {},
): ProgramStatusSnapshot {
	return {
		version: 1,
		repo: 'repo',
		key,
		pane,
		authoritative: true,
		exited: false,
		updatedAt: Date.now(),
		records: [],
		info: {status: 'idle', app: 'antigravity'},
		...overrides,
	};
}

test('a fresh OSC snapshot arriving during the wait confirms an agy or Codex start', async () => {
	const f = oscFixture();
	await f.state.daos.spaceIdentities.record(f.identity);
	const since = Date.now();
	let current: ProgramStatusSnapshot | null = null;
	setTimeout(() => {
		current = oscSnapshot(f.issueKey, f.pane, {updatedAt: Date.now()});
	}, 60);

	expect(
		await waitForAgentStart({
			claudeStatus: f.state.daos.claudeStatus,
			statusKey: `${f.state.repo}-${f.issueKey}`,
			worktree: f.worktree,
			since,
			timeoutMs: 5000,
			pollMs: 20,
			osc: {
				programStatus: {read: async () => current},
				spaceIdentities: f.state.daos.spaceIdentities,
				issueKey: f.issueKey,
				runner: f.runner,
			},
		}),
	).toBe(true);
});

test('an already-running idle OSC pane opened with --resume confirms even when snapshot predates since', async () => {
	const f = oscFixture();
	await f.state.daos.spaceIdentities.record(f.identity);
	const since = Date.now();
	const prior = oscSnapshot(f.issueKey, f.pane, {updatedAt: since - 60_000});

	expect(
		await waitForAgentStart({
			claudeStatus: f.state.daos.claudeStatus,
			statusKey: `${f.state.repo}-${f.issueKey}`,
			worktree: f.worktree,
			since,
			timeoutMs: 0,
			pollMs: 20,
			osc: {
				programStatus: {read: async () => prior},
				spaceIdentities: f.state.daos.spaceIdentities,
				issueKey: f.issueKey,
				runner: f.runner,
			},
		}),
	).toBe(true);
});

test('an agent that reported idle and then exited to a shell with the same generation does not confirm', async () => {
	for (const shell of ['bash', '-zsh']) {
		const f = oscFixture({command: shell});
		await f.state.daos.spaceIdentities.record(f.identity);
		const since = Date.now();
		const prior = oscSnapshot(f.issueKey, f.pane, {updatedAt: since - 60_000});
		expect(
			await waitForAgentStart({
				claudeStatus: f.state.daos.claudeStatus,
				statusKey: `${f.state.repo}-${f.issueKey}`,
				worktree: f.worktree,
				since,
				timeoutMs: 0,
				osc: {
					programStatus: {read: async () => prior},
					spaceIdentities: f.state.daos.spaceIdentities,
					issueKey: f.issueKey,
					runner: f.runner,
				},
			}),
		).toBe(false);
	}
});

test('a dead pane, exited monitor, unknown status, or mismatched generation does not confirm', async () => {
	const since = Date.now();
	const dead = oscFixture({dead: true});
	await dead.state.daos.spaceIdentities.record(dead.identity);
	expect(
		await waitForAgentStart({
			claudeStatus: dead.state.daos.claudeStatus,
			statusKey: `${dead.state.repo}-${dead.issueKey}`,
			worktree: dead.worktree,
			since,
			timeoutMs: 0,
			osc: {
				programStatus: {
					read: async () => oscSnapshot(dead.issueKey, dead.pane),
				},
				spaceIdentities: dead.state.daos.spaceIdentities,
				issueKey: dead.issueKey,
				runner: dead.runner,
			},
		}),
	).toBe(false);

	const live = oscFixture();
	await live.state.daos.spaceIdentities.record(live.identity);
	const otherPane = parseStatusPane(
		'%5\t42\t0\t1\t42.other',
		live.identity.tmux.socket,
	)!;
	for (const bad of [
		oscSnapshot(live.issueKey, live.pane, {exited: true}),
		oscSnapshot(live.issueKey, live.pane, {authoritative: false}),
		oscSnapshot(live.issueKey, live.pane, {info: {status: 'unknown'}}),
		oscSnapshot(live.issueKey, otherPane),
	]) {
		expect(
			await waitForAgentStart({
				claudeStatus: live.state.daos.claudeStatus,
				statusKey: `${live.state.repo}-${live.issueKey}`,
				worktree: live.worktree,
				since,
				timeoutMs: 0,
				osc: {
					programStatus: {read: async () => bad},
					spaceIdentities: live.state.daos.spaceIdentities,
					issueKey: live.issueKey,
					runner: live.runner,
				},
			}),
		).toBe(false);
	}
});
