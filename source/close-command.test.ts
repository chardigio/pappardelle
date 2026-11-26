import {test, expect} from 'bun:test';
import {
	type CloseCommandDeps,
	runCloseCommand,
	runCloseTeardown,
} from './close-command.ts';
import type {TrackerIssue} from './providers/types.ts';
import {
	killSpaceSessions,
	spaceSessionNames,
	type AsyncTmuxRunner,
} from './tmux.ts';
import {
	recordIdentities,
	testState,
	testTmuxState,
} from '../test/helpers/state.ts';

const ISSUE: TrackerIssue = {
	identifier: 'STA-1',
	title: 'Fix it',
	state: {name: 'Done', type: 'completed', color: '#fff'},
};

function fakeRegistry(
	open: string[],
	events: string[] = [],
): CloseCommandDeps['registry'] {
	return {
		phase: key =>
			open.includes(key) ? {kind: 'phase', phase: 'open'} : {kind: 'unknown'},
		async settle() {},
		async markClosing(key) {
			events.push(`closing ${key}`);
		},
		async reopen(key) {
			events.push(`reopen ${key}`);
		},
		async remove(key) {
			events.push(`unregister ${key}`);
		},
	};
}

function fakeDeps(overrides: Partial<CloseCommandDeps> = {}) {
	const events: string[] = [];
	const deps: CloseCommandDeps = {
		registry: fakeRegistry(['STA-1', 'STA-2'], events),
		async getIssue() {
			return ISSUE;
		},
		worktreePath: key => `/wt/${key}`,
		async runHooks(space) {
			events.push(
				`hooks ${space.name} ${space.worktreePath} ${space.trackerIssue?.identifier ?? 'no-issue'}`,
			);
			return {kind: 'ran'};
		},
		async killSpaceSessions(key) {
			events.push(`kill ${key}`);
			return true;
		},
		async cleanup(key) {
			events.push(`cleanup ${key}`);
			return true;
		},
		sessionNames: key => ({
			agent: `agent-repo-${key}`,
			companion: `companion-repo-${key}`,
		}),
		currentInnerSession: () => null,
		liveSessions: () => new Set(),
		mainRepoRoot: '/repo',
		spawnTeardown(key, cwd) {
			events.push(`spawn ${key} ${cwd}`);
		},
		isTTY: false,
		async confirm(question) {
			events.push(`confirm ${question}`);
			return false;
		},
		print(line) {
			events.push(`print ${line}`);
		},
		logError(message) {
			events.push(`log ${message}`);
		},
		...overrides,
	};
	return {deps, events};
}

test('--yes runs hooks, then kills before unregistering', async () => {
	const {deps, events} = fakeDeps();
	expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(0);
	expect(events).toStrictEqual([
		'print Running pre_workspace_deinit hooks...',
		'hooks STA-1 /wt/STA-1 STA-1',
		'print Ending sessions...',
		'closing STA-1',
		'kill STA-1',
		'unregister STA-1',
		'cleanup STA-1',
	]);
});

test('an unregistered key or main closes nothing', async () => {
	for (const key of ['STA-9', 'main']) {
		const {deps, events} = fakeDeps({
			registry: fakeRegistry(['STA-1', 'main']),
		});
		expect(await runCloseCommand({key, yes: true}, deps)).toBe(1);
		expect(events).toStrictEqual([`print No open space ${key}`]);
	}
});

test('without --yes off a terminal it refuses and closes nothing', async () => {
	const {deps, events} = fakeDeps();
	expect(await runCloseCommand({key: 'STA-1', yes: false}, deps)).toBe(1);
	expect(events).toStrictEqual([
		'print close needs --yes when not run from a terminal',
	]);
});

test('without --yes on a terminal it asks, and a no closes nothing', async () => {
	const {deps, events} = fakeDeps({isTTY: true});
	expect(await runCloseCommand({key: 'STA-1', yes: false}, deps)).toBe(0);
	expect(events).toStrictEqual([
		'confirm Close STA-1? Runs pre_workspace_deinit hooks and ends its agent and companion sessions. [y/N] ',
	]);
});

test('a yes at the prompt closes the space', async () => {
	const {deps, events} = fakeDeps({
		isTTY: true,
		async confirm() {
			return true;
		},
	});
	expect(await runCloseCommand({key: 'STA-1', yes: false}, deps)).toBe(0);
	expect(events.includes('unregister STA-1')).toBe(true);
});

test('a failed hook names the hook and leaves the space open', async () => {
	const {deps, events} = fakeDeps({
		async runHooks() {
			return {kind: 'failed', failedCommand: 'remove worktree'};
		},
	});
	expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(1);
	expect(events).toStrictEqual([
		'print Running pre_workspace_deinit hooks...',
		'print pre_workspace_deinit hook failed: remove worktree. STA-1 is still open',
	]);
});

test('an invalid config closes the space and says the deinit commands were skipped', async () => {
	const {deps, events} = fakeDeps({
		async runHooks() {
			return {
				kind: 'config-invalid',
				errors: ['agent_profiles.opus.model: must be a string'],
			};
		},
	});
	expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(0);
	expect(events.includes('unregister STA-1')).toBe(true);
	expect(
		events.includes(
			'print Skipped the deinit commands of STA-1: the config is invalid\nInvalid .pappardelle.yml configuration:\n  - agent_profiles.opus.model: must be a string',
		),
	).toBe(true);
});

test('a failed kill leaves the space registered', async () => {
	const {deps, events} = fakeDeps({
		async killSpaceSessions() {
			return false;
		},
	});
	expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(1);
	expect(events.some(event => event.startsWith('unregister'))).toBe(false);
	expect(
		events.includes('print Failed to end the tmux sessions for STA-1'),
	).toBe(true);
});

test('a tracker failure warns and still runs the global hooks', async () => {
	for (const getIssue of [
		async () => null,
		async () => {
			throw new Error('offline');
		},
	]) {
		const {deps, events} = fakeDeps({getIssue});
		expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(0);
		expect(events.slice(0, 3)).toStrictEqual([
			"print Couldn't load STA-1 from the tracker; skipping profile pre_workspace_deinit hooks",
			'print Running pre_workspace_deinit hooks...',
			'hooks STA-1 /wt/STA-1 no-issue',
		]);
		expect(events.includes('unregister STA-1')).toBe(true);
	}
});

test('closing the space this process runs in hands teardown to a detached child', async () => {
	for (const session of [
		'agent-repo-STA-1',
		'companion-repo-STA-1',
		'claude-repo-STA-1',
	]) {
		const {deps, events} = fakeDeps({currentInnerSession: () => session});
		expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(0);
		expect(events).toStrictEqual([
			'print Running pre_workspace_deinit hooks...',
			'hooks STA-1 /wt/STA-1 STA-1',
			'print Ending this session; teardown finishes in the background',
			'spawn STA-1 /repo',
		]);
	}
});

test("another space's session tears down in-process", async () => {
	const {deps, events} = fakeDeps({
		currentInnerSession: () => 'agent-repo-STA-2',
	});
	expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(0);
	expect(events.some(event => event.startsWith('spawn'))).toBe(false);
	expect(events.includes('kill STA-1')).toBe(true);
});

test('teardown-only skips the prompt and hooks and logs failures', async () => {
	const {deps, events} = fakeDeps({
		async killSpaceSessions(key) {
			events.push(`kill ${key}`);
			return false;
		},
	});
	expect(await runCloseTeardown('STA-1', deps)).toBe(1);
	expect(events).toStrictEqual([
		'closing STA-1',
		'kill STA-1',
		'reopen STA-1',
		'log Failed to end the tmux sessions for STA-1',
	]);

	const ok = fakeDeps();
	expect(await runCloseTeardown('STA-1', ok.deps)).toBe(0);
	expect(ok.events).toStrictEqual([
		'closing STA-1',
		'kill STA-1',
		'unregister STA-1',
		'cleanup STA-1',
	]);
});

test('teardown-only refuses main and keys that are not open', async () => {
	for (const key of ['main', 'STA-9']) {
		const {deps, events} = fakeDeps({
			registry: fakeRegistry(['STA-1', 'main']),
		});
		expect(await runCloseTeardown(key, deps)).toBe(1);
		expect(events).toStrictEqual([`log No open space ${key}`]);
	}
});

test('close waits for simulator cleanup before it returns', async () => {
	for (const close of [
		async (deps: CloseCommandDeps) =>
			runCloseCommand({key: 'STA-1', yes: true}, deps),
		async (deps: CloseCommandDeps) => runCloseTeardown('STA-1', deps),
	]) {
		const {deps, events} = fakeDeps({
			async cleanup(key) {
				await new Promise(resolve => {
					setTimeout(resolve, 20);
				});
				events.push(`cleanup done ${key}`);
				return true;
			},
		});
		expect(await close(deps)).toBe(0);
		expect(events.at(-1)).toBe('cleanup done STA-1');
	}
});

const closes = [
	async (deps: CloseCommandDeps) =>
		runCloseCommand({key: 'STA-1', yes: true}, deps),
	async (deps: CloseCommandDeps) => runCloseTeardown('STA-1', deps),
];

function busyRegistry(
	failing: 'markClosing' | 'remove',
	events: string[],
): CloseCommandDeps['registry'] {
	return {
		...fakeRegistry(['STA-1'], events),
		async [failing]() {
			throw new Error('database is locked');
		},
	};
}

// idow opens it when setup finishes, which would undo the close.
test('a space still being set up is not closed', async () => {
	for (const close of closes) {
		const events: string[] = [];
		const {deps} = fakeDeps({
			registry: {
				...fakeRegistry([], events),
				phase: () => ({kind: 'phase', phase: 'starting'}),
			},
		});
		expect(await close(deps)).toBe(1);
		expect(
			events.some(event => /^(closing|kill|unregister) /.test(event)),
		).toBe(false);
	}
});

// No pid is this high, so the owner reads as dead.
const DEAD_PID = 2_147_483_646;

test('a space whose setup died is closed when its sessions run, and is gone when they do not', async () => {
	for (const running of [true, false]) {
		const state = testState();
		await recordIdentities(state, ['STA-1']);
		await state.daos.registry.reserveStart('STA-1', DEAD_PID);
		const {deps, events} = fakeDeps({
			registry: state.daos.registry,
			sessionNames: () => null,
			liveSessions: () => new Set(running ? [`agent-${state.repo}-STA-1`] : []),
		});
		expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(
			running ? 0 : 1,
		);
		expect(events.includes('kill STA-1')).toBe(running);
		expect(state.daos.registry.phase('STA-1')).toStrictEqual({kind: 'unknown'});
	}
});

test('a space still being set up by a live idow is not closed', async () => {
	const state = testState();
	await recordIdentities(state, ['STA-1']);
	await state.daos.registry.reserveStart('STA-1', process.ppid);
	const {deps, events} = fakeDeps({
		registry: state.daos.registry,
		liveSessions: () => new Set([`agent-${state.repo}-STA-1`]),
	});
	expect(await runCloseCommand({key: 'STA-1', yes: true}, deps)).toBe(1);
	expect(events.includes('kill STA-1')).toBe(false);
});

test('a close that the registry cannot record ends no sessions and says why', async () => {
	for (const close of closes) {
		const {deps, events} = fakeDeps();
		deps.registry = busyRegistry('markClosing', events);
		expect(await close(deps)).toBe(1);
		expect(events.some(event => event.startsWith('kill'))).toBe(false);
		expect(events.at(-1)!).toMatch(
			/^(print|log) Could not start closing STA-1: database is locked\. Its sessions were not ended and it is still open$/,
		);
	}
});

test('a space the registry cannot remove is reported as closed but still registered', async () => {
	for (const close of closes) {
		const {deps, events} = fakeDeps();
		deps.registry = busyRegistry('remove', events);
		expect(await close(deps)).toBe(1);
		expect(events.includes('kill STA-1')).toBe(true);
		expect(events.at(-1)!).toMatch(
			/^(print|log) Ended the sessions of STA-1, but could not remove it from the registry: database is locked\. Run close again to finish$/,
		);
	}
});

// tmux.ts reads one set of stores for the whole process.
test('close kills the sessions stored for the space, and knows its own session by them', async () => {
	const state = testTmuxState();
	await state.daos.spaceIdentities.record({
		repo: state.repo,
		key: 'STA-1',
		worktreePath: '/wt/STA-1',
		tmux: {
			socket: 'pappardelle_inner',
			agentSession: 'agent-hand-named',
			companionSession: 'companion-hand-named',
		},
	});
	const killed: string[] = [];
	const run: AsyncTmuxRunner = async args => {
		if (args.includes('kill-session')) killed.push(args.at(-1)!);
		return '';
	};

	const {deps} = fakeDeps({
		killSpaceSessions: async key => killSpaceSessions(key, {run}),
		sessionNames: spaceSessionNames,
	});
	expect(await runCloseTeardown('STA-1', deps)).toBe(0);
	expect(killed).toStrictEqual([
		'=companion-hand-named:',
		'=agent-hand-named:',
		'=claude-hand-named:',
	]);

	const inside = fakeDeps({
		sessionNames: spaceSessionNames,
		currentInnerSession: () => 'agent-hand-named',
	});
	expect(await runCloseCommand({key: 'STA-1', yes: true}, inside.deps)).toBe(0);
	expect(inside.events.includes('spawn STA-1 /repo')).toBe(true);
});

// tmux.ts reads one set of stores for the whole process.
test('a space with no stored names closes with no sessions to end', async () => {
	testTmuxState();
	const calls: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		return '';
	};

	const {deps, events} = fakeDeps({
		killSpaceSessions: async key => killSpaceSessions(key, {run}),
	});
	expect(await runCloseTeardown('STA-1', deps)).toBe(0);
	expect(calls).toStrictEqual([]);
	expect(events.includes('unregister STA-1')).toBe(true);
});
