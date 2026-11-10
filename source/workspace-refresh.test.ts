import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
import {
	WorkspaceRefresh,
	type WorkspaceRefreshDeps,
} from './workspace-refresh.ts';
import type {SpaceData, TrackerIssue} from './types.ts';
import type {ProgramStatusInfo} from './program-status.ts';

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
		readStatus: async () => ({status: 'idle'}),
		readWorktreePath: async key => `/worktrees/${key}`,
		readMainWorktree: async () => ({path: '/repo', branch: 'master'}),
		readDirty: async () => false,
		statusKey: name => `repo-${name}`,
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

test('first-paint gate publishes membership before workspace details', async t => {
	const painted = deferred<void>();
	const loaded = deferred<void>();
	const h = setup({
		detailReady: painted.promise,
		onLoaded: () => loaded.resolve(),
	});
	const pending = h.refresh.refresh();
	await loaded.promise;
	for (let turn = 0; turn < 4; turn++) await nextTurn();
	t.deepEqual(
		h.spaces.map(space => space.name),
		['main', 'STA-2', 'STA-1'],
	);
	t.is(h.spaces[1]!.worktreePath, null);
	t.is(h.spaces[1]!.programStatus?.status, 'unknown');
	painted.resolve();
	await pending;
	await h.refresh.idle();
	t.is(h.spaces[1]!.worktreePath, '/worktrees/STA-2');
	t.is(h.spaces[1]!.programStatus?.status, 'idle');
});

test('closing before first paint suppresses deferred detail publication', async t => {
	const painted = deferred<void>();
	const loaded = deferred<void>();
	const h = setup({
		detailReady: painted.promise,
		onLoaded: () => loaded.resolve(),
	});
	const pending = h.refresh.refresh();
	await loaded.promise;
	for (let turn = 0; turn < 4; turn++) await nextTurn();
	h.refresh.stop();
	const before = h.spaces;
	painted.resolve();
	await pending;
	await h.refresh.idle();
	t.is(h.spaces, before);
	t.is(h.spaces[1]!.worktreePath, null);
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
	const stale = deferred<ProgramStatusInfo>();
	h.deps.readStatus = async () => stale.promise;
	const pending = h.refresh.refresh();
	await nextTurn();
	h.refresh.applyStatusUpdates(
		new Map([
			['repo-STA-1', {status: 'working', tool: 'AskUserQuestion'}],
			['repo-master', {status: 'working'}],
		]),
	);
	stale.resolve({status: 'idle'});
	await pending;
	await h.refresh.idle();
	t.is(h.spaces[2]!.programStatus?.tool, 'AskUserQuestion');
	t.is(h.spaces[2]!.programStatus?.status, 'working');
	t.is(h.spaces[0]!.programStatus?.status, 'working');
	t.is(h.spaces[1]!.programStatus?.status, 'idle');
	h.deps.readStatus = async () => ({status: 'unknown'});
	await h.settle();
	t.is(h.spaces[2]!.programStatus?.status, 'unknown');
	t.is(h.spaces[2]!.programStatus?.tool, undefined);
});

test('a space reads and takes hook updates under its repo-qualified key', async t => {
	const reads = new Map<string, string>();
	const h = setup({
		readRegistry: async () => ['STA-1'],
		async readStatus(key, sessionKey) {
			reads.set(key, sessionKey);
			return {status: 'idle'};
		},
	});
	await h.settle();
	t.is(reads.get('repo-STA-1'), 'STA-1');
	t.is(reads.get('repo-master'), 'main');
	t.is(reads.size, 2);
	h.refresh.applyStatusUpdates(new Map([['other-STA-1', {status: 'error'}]]));
	t.is(h.spaces[1]!.programStatus?.status, 'idle');
	h.refresh.applyStatusUpdates(new Map([['repo-STA-1', {status: 'error'}]]));
	t.is(h.spaces[1]!.programStatus?.status, 'error');
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
	h.refresh.applyStatusUpdates(new Map([['repo-STA-1', {status: 'error'}]]));
	await pending;
	await h.refresh.idle();
	t.is(h.spaces, before);
});

test('spaces list newest number first, and beads hash keys keep one order whatever the registry order', async t => {
	const order = async (registry: string[]) => {
		const h = setup({readRegistry: async () => registry});
		await h.settle();
		return h.spaces.filter(space => !space.isMainWorktree).map(s => s.name);
	};

	t.deepEqual(await order(['STA-9', 'ABC-50', 'STA-12', 'STA-100']), [
		'STA-100',
		'ABC-50',
		'STA-12',
		'STA-9',
	]);
	const keys = ['fl-ec0', 'fl-1a2', 'fl-zz9', 'fl-x3'];
	t.deepEqual(await order(keys), await order([...keys].reverse()));
});
