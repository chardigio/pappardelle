import test from 'ava';
import {
	type CloseCommandDeps,
	runCloseCommand,
	runCloseTeardown,
} from './close-command.ts';
import type {TrackerIssue} from './providers/types.ts';

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
		keepsLifecycle: false,
		has: key => open.includes(key),
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
			return {success: true};
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
			legacyAgent: `claude-repo-${key}`,
		}),
		currentInnerSession: () => null,
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

test('--yes runs hooks, then kills before unregistering', async t => {
	const {deps, events} = fakeDeps();
	t.is(await runCloseCommand({key: 'STA-1', yes: true}, deps), 0);
	t.deepEqual(events, [
		'print Running pre_workspace_deinit hooks...',
		'hooks STA-1 /wt/STA-1 STA-1',
		'print Ending sessions...',
		'closing STA-1',
		'kill STA-1',
		'unregister STA-1',
		'cleanup STA-1',
	]);
});

test('an unregistered key or main closes nothing', async t => {
	for (const key of ['STA-9', 'main']) {
		const {deps, events} = fakeDeps({
			registry: fakeRegistry(['STA-1', 'main']),
		});
		t.is(await runCloseCommand({key, yes: true}, deps), 1);
		t.deepEqual(events, [`print No open space ${key}`]);
	}
});

test('without --yes off a terminal it refuses and closes nothing', async t => {
	const {deps, events} = fakeDeps();
	t.is(await runCloseCommand({key: 'STA-1', yes: false}, deps), 1);
	t.deepEqual(events, ['print close needs --yes when not run from a terminal']);
});

test('without --yes on a terminal it asks, and a no closes nothing', async t => {
	const {deps, events} = fakeDeps({isTTY: true});
	t.is(await runCloseCommand({key: 'STA-1', yes: false}, deps), 0);
	t.deepEqual(events, [
		'confirm Close STA-1? Runs pre_workspace_deinit hooks and ends its agent and companion sessions. [y/N] ',
	]);
});

test('a yes at the prompt closes the space', async t => {
	const {deps, events} = fakeDeps({
		isTTY: true,
		async confirm() {
			return true;
		},
	});
	t.is(await runCloseCommand({key: 'STA-1', yes: false}, deps), 0);
	t.true(events.includes('unregister STA-1'));
});

test('a failed hook names the hook and leaves the space open', async t => {
	const {deps, events} = fakeDeps({
		async runHooks() {
			return {success: false, failedCommand: 'remove worktree'};
		},
	});
	t.is(await runCloseCommand({key: 'STA-1', yes: true}, deps), 1);
	t.deepEqual(events, [
		'print Running pre_workspace_deinit hooks...',
		'print pre_workspace_deinit hook failed: remove worktree. STA-1 is still open',
	]);
});

test('a failed kill leaves the space registered', async t => {
	const {deps, events} = fakeDeps({
		async killSpaceSessions() {
			return false;
		},
	});
	t.is(await runCloseCommand({key: 'STA-1', yes: true}, deps), 1);
	t.false(events.some(event => event.startsWith('unregister')));
	t.true(events.includes('print Failed to end the tmux sessions for STA-1'));
});

test('a tracker failure warns and still runs the global hooks', async t => {
	for (const getIssue of [
		async () => null,
		async () => {
			throw new Error('offline');
		},
	]) {
		const {deps, events} = fakeDeps({getIssue});
		t.is(await runCloseCommand({key: 'STA-1', yes: true}, deps), 0);
		t.deepEqual(events.slice(0, 3), [
			"print Couldn't load STA-1 from the tracker; skipping profile pre_workspace_deinit hooks",
			'print Running pre_workspace_deinit hooks...',
			'hooks STA-1 /wt/STA-1 no-issue',
		]);
		t.true(events.includes('unregister STA-1'));
	}
});

test('closing the space this process runs in hands teardown to a detached child', async t => {
	for (const session of [
		'agent-repo-STA-1',
		'companion-repo-STA-1',
		'claude-repo-STA-1',
	]) {
		const {deps, events} = fakeDeps({currentInnerSession: () => session});
		t.is(await runCloseCommand({key: 'STA-1', yes: true}, deps), 0);
		t.deepEqual(events, [
			'print Running pre_workspace_deinit hooks...',
			'hooks STA-1 /wt/STA-1 STA-1',
			'print Ending this session; teardown finishes in the background',
			'spawn STA-1 /repo',
		]);
	}
});

test("another space's session tears down in-process", async t => {
	const {deps, events} = fakeDeps({
		currentInnerSession: () => 'agent-repo-STA-2',
	});
	t.is(await runCloseCommand({key: 'STA-1', yes: true}, deps), 0);
	t.false(events.some(event => event.startsWith('spawn')));
	t.true(events.includes('kill STA-1'));
});

test('teardown-only skips the prompt and hooks and logs failures', async t => {
	const {deps, events} = fakeDeps({
		async killSpaceSessions(key) {
			events.push(`kill ${key}`);
			return false;
		},
	});
	t.is(await runCloseTeardown('STA-1', deps), 1);
	t.deepEqual(events, [
		'closing STA-1',
		'kill STA-1',
		'reopen STA-1',
		'log Failed to end the tmux sessions for STA-1',
	]);

	const ok = fakeDeps();
	t.is(await runCloseTeardown('STA-1', ok.deps), 0);
	t.deepEqual(ok.events, [
		'closing STA-1',
		'kill STA-1',
		'unregister STA-1',
		'cleanup STA-1',
	]);
});

test('teardown-only refuses main and keys that are not open', async t => {
	for (const key of ['main', 'STA-9']) {
		const {deps, events} = fakeDeps({
			registry: fakeRegistry(['STA-1', 'main']),
		});
		t.is(await runCloseTeardown(key, deps), 1);
		t.deepEqual(events, [`log No open space ${key}`]);
	}
});

test('close waits for simulator cleanup before it returns', async t => {
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
		t.is(await close(deps), 0);
		t.is(events.at(-1), 'cleanup done STA-1');
	}
});

const closes = [
	async (deps: CloseCommandDeps) =>
		runCloseCommand({key: 'STA-1', yes: true}, deps),
	async (deps: CloseCommandDeps) => runCloseTeardown('STA-1', deps),
];

function busyRegistry(
	failing: 'markClosing' | 'remove',
	keepsLifecycle: boolean,
	events: string[],
): CloseCommandDeps['registry'] {
	return {
		...fakeRegistry(['STA-1'], events),
		keepsLifecycle,
		async [failing]() {
			throw new Error('database is locked');
		},
	};
}

test('a close that a lifecycle registry cannot record ends no sessions and says why', async t => {
	for (const close of closes) {
		const {deps, events} = fakeDeps();
		deps.registry = busyRegistry('markClosing', true, events);
		t.is(await close(deps), 1);
		t.false(events.some(event => event.startsWith('kill')));
		t.regex(
			events.at(-1)!,
			/^(print|log) Could not start closing STA-1: database is locked\. Its sessions were not ended and it is still open$/,
		);
	}
});

test('a space a lifecycle registry cannot remove is reported as closed but still registered', async t => {
	for (const close of closes) {
		const {deps, events} = fakeDeps();
		deps.registry = busyRegistry('remove', true, events);
		t.is(await close(deps), 1);
		t.true(events.includes('kill STA-1'));
		t.regex(
			events.at(-1)!,
			/^(print|log) Ended the sessions of STA-1, but could not remove it from the registry: database is locked\. Run close again to finish$/,
		);
	}
});

test('a registry without a lifecycle still fails a close with the error it threw', async t => {
	for (const failing of ['markClosing', 'remove'] as const) {
		for (const close of closes) {
			const {deps, events} = fakeDeps();
			deps.registry = busyRegistry(failing, false, events);
			await t.throwsAsync(close(deps), {message: 'database is locked'});
			t.false(events.some(event => event.includes('database is locked')));
		}
	}
});
