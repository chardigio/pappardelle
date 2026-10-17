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

function fakeDeps(overrides: Partial<CloseCommandDeps> = {}) {
	const events: string[] = [];
	const deps: CloseCommandDeps = {
		registeredSpaces: () => ['STA-1', 'STA-2'],
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
		async removeSpace(key) {
			events.push(`unregister ${key}`);
		},
		async cleanup(key) {
			events.push(`cleanup ${key}`);
			return true;
		},
		sessionNames: key => ({
			claude: `claude-repo-${key}`,
			companion: `companion-repo-${key}`,
		}),
		currentInnerSession: () => null,
		mainRepoRoot: '/repo',
		chdir(dir) {
			events.push(`chdir ${dir}`);
		},
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
		'chdir /repo',
		'print Ending sessions...',
		'kill STA-1',
		'unregister STA-1',
		'cleanup STA-1',
	]);
});

test('an unregistered key or main closes nothing', async t => {
	for (const key of ['STA-9', 'main']) {
		const {deps, events} = fakeDeps({
			registeredSpaces: () => ['STA-1', 'main'],
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
		'confirm Close STA-1? Runs pre_workspace_deinit hooks and ends its Claude and companion sessions. [y/N] ',
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
	for (const session of ['claude-repo-STA-1', 'companion-repo-STA-1']) {
		const {deps, events} = fakeDeps({currentInnerSession: () => session});
		t.is(await runCloseCommand({key: 'STA-1', yes: true}, deps), 0);
		t.deepEqual(events, [
			'print Running pre_workspace_deinit hooks...',
			'hooks STA-1 /wt/STA-1 STA-1',
			'chdir /repo',
			'print Ending this session; teardown finishes in the background',
			'spawn STA-1 /repo',
		]);
	}
});

test("another space's session tears down in-process", async t => {
	const {deps, events} = fakeDeps({
		currentInnerSession: () => 'claude-repo-STA-2',
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
		'kill STA-1',
		'log Failed to end the tmux sessions for STA-1',
	]);

	const ok = fakeDeps();
	t.is(await runCloseTeardown('STA-1', ok.deps), 0);
	t.deepEqual(ok.events, ['kill STA-1', 'unregister STA-1', 'cleanup STA-1']);
});
