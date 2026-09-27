import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
import {
	WorkspaceRefresh,
	type WorkspaceRefreshDeps,
} from './workspace-refresh.ts';
import type {SpaceData, TrackerIssue} from './types.ts';
import type {ClaudeStatusInfo} from './claude-status.ts';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(_resolve => {
		resolve = _resolve;
	});
	return {promise, resolve};
}

const issue = (key: string): TrackerIssue => ({
	identifier: key,
	title: key,
	url: '',
	state: {name: 'Open', type: 'unstarted', color: '#fff'},
});

function setup(overrides: Partial<WorkspaceRefreshDeps> = {}) {
	let spaces: SpaceData[] = [];
	const errors: unknown[] = [];
	const publications: SpaceData[][] = [];
	const deps: WorkspaceRefreshDeps = {
		readRegistry: async () => ['STA-1', 'STA-2'],
		readStatus: async () => ({status: 'waiting_for_input'}),
		readWorktreePath: async key => `/worktrees/${key}`,
		readMainWorktree: async () => ({path: '/repo', branch: 'master'}),
		readDirty: async () => false,
		mainStatusKey: branch => `repo-${branch}`,
		getCachedIssue: issue,
		async fetchIssues() {},
		readEmoji: async () => '🍝',
		setSpaces(update) {
			const next = update(spaces);
			if (next !== spaces) publications.push(next);
			spaces = next;
		},
		onLoaded() {},
		onError(error) {
			errors.push(error);
		},
		...overrides,
	};
	const refresh = new WorkspaceRefresh(deps);
	return {
		refresh,
		deps,
		errors,
		publications,
		get spaces() {
			return spaces;
		},
		async settle() {
			await refresh.refresh();
			await refresh.idle();
		},
	};
}

test('membership publishes while main discovery and dirty status are pending', async t => {
	const main = deferred<{path: string; branch: string}>();
	const dirty = deferred<boolean>();
	const h = setup({
		readMainWorktree: async () => main.promise,
		readDirty: async () => dirty.promise,
	});
	await h.refresh.refresh();
	t.deepEqual(
		h.spaces.map(space => space.name),
		['main', 'STA-2', 'STA-1'],
	);
	t.true(h.spaces[0]!.isMainWorktree);
	main.resolve({path: '/repo', branch: 'master'});
	await nextTurn();
	t.is(h.spaces[0]!.statusKey, 'repo-master');
	t.is(h.spaces[0]!.worktreePath, '/repo');
	h.deps.readRegistry = async () => ['STA-3', 'STA-1'];
	await h.refresh.refresh();
	t.deepEqual(
		h.spaces.map(space => space.name),
		['main', 'STA-3', 'STA-1'],
	);
	dirty.resolve(true);
	await h.refresh.idle();
	t.true(h.spaces[0]!.isDirty);
});

test('no-op polling retains the array, rows, tracker aliases and pending rows', async t => {
	const h = setup();
	await h.settle();
	h.deps.setSpaces(spaces =>
		spaces.map(space =>
			space.name === 'STA-1'
				? {
						...space,
						trackerIssue: space.linearIssue,
						railStatus: {pipeline: 'passing', unresolvedCommentCount: 2},
					}
				: space,
		),
	);
	const pending: SpaceData = {
		name: 'opening',
		worktreePath: null,
		isPending: true,
		pendingTitle: 'Opening…',
	};
	h.deps.setSpaces(spaces => [...spaces, pending]);
	const before = h.spaces;
	const commits = h.publications.length;
	await h.settle();
	t.is(h.spaces, before);
	t.is(h.publications.length, commits);
	t.is(h.spaces.at(-1), pending);
	t.is(h.spaces[2]!.trackerIssue, before[2]!.trackerIssue);
	h.deps.readRegistry = async () => ['STA-3', 'STA-1'];
	await h.settle();
	t.is(h.spaces[0], before[0]);
	t.is(h.spaces[2], before[2]);
	t.is(h.spaces[3], pending);
});

test('newer workspace and main hooks survive an older disk read, then polling repairs missed events', async t => {
	const h = setup();
	await h.settle();
	const stale = deferred<ClaudeStatusInfo>();
	h.deps.readStatus = async () => stale.promise;
	const pending = h.refresh.refresh();
	await nextTurn();
	h.refresh.applyHookUpdates(
		new Map([
			['STA-1', {status: 'running_tool', tool: 'AskUserQuestion'}],
			['repo-master', {status: 'processing'}],
		]),
	);
	stale.resolve({status: 'ended'});
	await pending;
	await h.refresh.idle();
	t.is(h.spaces[2]!.claudeTool, 'AskUserQuestion');
	t.is(h.spaces[2]!.claudeStatus, 'running_tool');
	t.is(h.spaces[0]!.claudeStatus, 'processing');
	t.is(h.spaces[1]!.claudeStatus, 'ended');
	h.deps.readStatus = async () => ({status: 'unknown'});
	await h.settle();
	t.is(h.spaces[2]!.claudeStatus, 'unknown');
	t.is(h.spaces[2]!.claudeTool, undefined);
});

test('coalesces overlapping requests and discards a registry snapshot predating a local close', async t => {
	const h = setup();
	await h.settle();
	const snapshot = deferred<string[]>();
	let reads = 0;
	h.deps.readRegistry = async () => {
		reads++;
		return reads === 1 ? snapshot.promise : ['STA-1'];
	};
	const first = h.refresh.refresh();
	await nextTurn();
	h.deps.setSpaces(spaces => spaces.filter(space => space.name !== 'STA-2'));
	const start = h.publications.length;
	const overlapping = Array.from({length: 20}, async () =>
		h.refresh.refreshListOnly(),
	);
	snapshot.resolve(['STA-2', 'STA-1']);
	await Promise.all([first, ...overlapping]);
	await h.refresh.idle();
	t.is(reads, 2);
	t.false(
		h.publications
			.slice(start)
			.some(spaces => spaces.some(space => space.name === 'STA-2')),
	);
	t.deepEqual(
		h.spaces.map(space => space.name),
		['main', 'STA-1'],
	);
});

test('bounds per-workspace I/O and serializes slow tracker and main requests', async t => {
	const gate = deferred<void>();
	let active = 0;
	let peak = 0;
	let trackerReads = 0;
	let mainReads = 0;
	const h = setup({
		readRegistry: async () => Array.from({length: 100}, (_, i) => `STA-${i}`),
		async readStatus(key) {
			if (key === 'repo-master') return {status: 'unknown'};
			active++;
			peak = Math.max(peak, active);
			await gate.promise;
			active--;
			return {status: 'unknown'};
		},
		async fetchIssues() {
			trackerReads++;
			await gate.promise;
		},
		async readMainWorktree() {
			mainReads++;
			await gate.promise;
			return {path: '/repo', branch: 'master'};
		},
	});
	const first = h.refresh.refresh();
	await nextTurn();
	const more = Array.from({length: 20}, async () => h.refresh.refresh());
	t.is(mainReads, 1);
	gate.resolve();
	await Promise.all([first, ...more]);
	await h.refresh.idle();
	t.is(peak, 4);
	t.is(mainReads, 2);
	t.true(trackerReads <= 2);
	t.is(h.spaces.length, 101);
});

test('metadata failures retain prior rows and a valid empty registry removes only registered rows', async t => {
	const h = setup();
	await h.settle();
	const before = h.spaces;
	const fail = async (): Promise<never> => {
		throw new Error('unavailable');
	};
	h.deps.readRegistry = fail;
	h.deps.readMainWorktree = fail;
	await h.settle();
	t.is(h.spaces, before);
	t.is(h.errors.length, 2);
	h.deps.readRegistry = async () => null;
	await h.settle();
	t.is(h.spaces, before);
	h.deps.readRegistry = async () => ['STA-1', 'STA-2'];
	h.deps.readMainWorktree = async () => ({path: '/repo', branch: 'master'});
	h.deps.readDirty = async () => null;
	h.deps.readStatus = async () => null;
	h.deps.readWorktreePath = fail;
	h.deps.readEmoji = fail;
	await h.settle();
	t.is(h.spaces, before);
	h.deps.readRegistry = async () => [];
	await h.settle();
	t.deepEqual(h.spaces, [before[0]!]);
});

test('stop suppresses late disk, tracker and hook publications', async t => {
	const h = setup();
	await h.settle();
	const gate = deferred<string[]>();
	h.deps.readRegistry = async () => gate.promise;
	const pending = h.refresh.refresh();
	await nextTurn();
	h.refresh.stop();
	const before = h.spaces;
	gate.resolve(['STA-99']);
	h.refresh.applyHookUpdates(new Map([['STA-1', {status: 'error'}]]));
	await pending;
	await h.refresh.idle();
	t.is(h.spaces, before);
});
