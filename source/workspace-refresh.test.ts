import {setImmediate as nextTurn} from 'node:timers/promises';
import {test, expect} from 'bun:test';
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
		statusReader: () => async () => ({status: 'idle'}),
		readWorktreePath: async key => `/worktrees/${key}`,
		readMainWorktree: async () => ({path: '/repo', branch: 'master'}),
		readDirty: async () => false,
		statusKey: async (key, mainBranch) => `repo-${mainBranch ?? key}`,
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

test('membership publishes while main discovery and dirty status are pending', async () => {
	const main = deferred<{path: string; branch: string}>();
	const dirty = deferred<boolean>();
	const h = setup({
		readMainWorktree: async () => main.promise,
		readDirty: async () => dirty.promise,
	});
	await h.refresh.refresh();
	expect(h.spaces.map(space => space.name)).toStrictEqual([
		'main',
		'STA-2',
		'STA-1',
	]);
	expect(h.spaces[0]!.isMainWorktree).toBe(true);
	main.resolve({path: '/repo', branch: 'master'});
	await nextTurn();
	expect(h.spaces[0]!.statusKey).toBe('repo-master');
	expect(h.spaces[0]!.worktreePath).toBe('/repo');
	h.deps.readRegistry = async () => ['STA-3', 'STA-1'];
	await h.refresh.refresh();
	expect(h.spaces.map(space => space.name)).toStrictEqual([
		'main',
		'STA-3',
		'STA-1',
	]);
	dirty.resolve(true);
	await h.refresh.idle();
	expect(h.spaces[0]!.isDirty).toBe(true);
});

test('first-paint gate publishes membership before workspace details', async () => {
	const painted = deferred<void>();
	const loaded = deferred<void>();
	const h = setup({
		detailReady: painted.promise,
		onLoaded: () => loaded.resolve(),
	});
	const pending = h.refresh.refresh();
	await loaded.promise;
	for (let turn = 0; turn < 4; turn++) await nextTurn();
	expect(h.spaces.map(space => space.name)).toStrictEqual([
		'main',
		'STA-2',
		'STA-1',
	]);
	expect(h.spaces[1]!.worktreePath).toBe(null);
	expect(h.spaces[1]!.programStatus?.status).toBe('unknown');
	painted.resolve();
	await pending;
	await h.refresh.idle();
	expect(h.spaces[1]!.worktreePath).toBe('/worktrees/STA-2');
	expect(h.spaces[1]!.programStatus?.status).toBe('idle');
});

test('closing before first paint suppresses deferred detail publication', async () => {
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
	expect(h.spaces).toBe(before);
	expect(h.spaces[1]!.worktreePath).toBe(null);
});

test('no-op polling retains the array, rows, tracker aliases and pending rows', async () => {
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
	expect(h.spaces).toBe(before);
	expect(h.publications.length).toBe(commits);
	expect(h.spaces.at(-1)).toBe(pending);
	expect(h.spaces[2]!.trackerIssue).toBe(before[2]!.trackerIssue);
	h.deps.readRegistry = async () => ['STA-3', 'STA-1'];
	await h.settle();
	expect(h.spaces[0]).toBe(before[0]);
	expect(h.spaces[2]).toBe(before[2]);
	expect(h.spaces[3]).toBe(pending);
});

test('newer workspace and main hooks survive an older disk read, then polling repairs missed events', async () => {
	const h = setup();
	await h.settle();
	const stale = deferred<ProgramStatusInfo>();
	h.deps.statusReader = () => async () => stale.promise;
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
	expect(h.spaces[2]!.programStatus?.tool).toBe('AskUserQuestion');
	expect(h.spaces[2]!.programStatus?.status).toBe('working');
	expect(h.spaces[0]!.programStatus?.status).toBe('working');
	expect(h.spaces[1]!.programStatus?.status).toBe('idle');
	h.deps.statusReader = () => async () => ({status: 'unknown'});
	await h.settle();
	expect(h.spaces[2]!.programStatus?.status).toBe('unknown');
	expect(h.spaces[2]!.programStatus?.tool).toBe(undefined);
});

test('a space reads and takes hook updates under its repo-qualified key', async () => {
	const reads = new Map<string, string>();
	const h = setup({
		readRegistry: async () => ['STA-1'],
		statusReader: () => async (key, sessionKey) => {
			reads.set(key, sessionKey);
			return {status: 'idle'};
		},
	});
	await h.settle();
	expect(reads.get('repo-STA-1')).toBe('STA-1');
	expect(reads.get('repo-master')).toBe('main');
	expect(reads.size).toBe(2);
	h.refresh.applyStatusUpdates(new Map([['other-STA-1', {status: 'error'}]]));
	expect(h.spaces[1]!.programStatus?.status).toBe('idle');
	h.refresh.applyStatusUpdates(new Map([['repo-STA-1', {status: 'error'}]]));
	expect(h.spaces[1]!.programStatus?.status).toBe('error');
});

test('a space moves to the qualified status key once its agent writes it', async () => {
	let bare = true;
	const h = setup({
		readRegistry: async () => ['STA-1'],
		statusKey: async name => (bare && name === 'STA-1' ? name : `repo-${name}`),
	});
	await h.settle();
	expect(h.spaces[1]!.statusKey).toBe('STA-1');
	bare = false;
	await h.refresh.refresh();
	await h.refresh.idle();
	expect(h.spaces[1]!.statusKey).toBe('repo-STA-1');
	h.refresh.applyStatusUpdates(new Map([['repo-STA-1', {status: 'error'}]]));
	expect(h.spaces[1]!.programStatus?.status).toBe('error');
});

test('coalesces overlapping requests and discards a registry snapshot predating a local close', async () => {
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
	expect(reads).toBe(2);
	expect(
		h.publications
			.slice(start)
			.some(spaces => spaces.some(space => space.name === 'STA-2')),
	).toBe(false);
	expect(h.spaces.map(space => space.name)).toStrictEqual(['main', 'STA-1']);
});

test('bounds per-workspace I/O and serializes slow tracker and main requests', async () => {
	const gate = deferred<void>();
	let active = 0;
	let peak = 0;
	let trackerReads = 0;
	let mainReads = 0;
	const h = setup({
		readRegistry: async () => Array.from({length: 100}, (_, i) => `STA-${i}`),
		statusReader: () => async key => {
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
	expect(mainReads).toBe(1);
	gate.resolve();
	await Promise.all([first, ...more]);
	await h.refresh.idle();
	expect(peak).toBe(4);
	expect(mainReads).toBe(2);
	expect(trackerReads <= 2).toBe(true);
	expect(h.spaces.length).toBe(101);
});

test('metadata failures retain prior rows and a valid empty registry removes only registered rows', async () => {
	const h = setup();
	await h.settle();
	const before = h.spaces;
	const fail = async (): Promise<never> => {
		throw new Error('unavailable');
	};
	h.deps.readRegistry = fail;
	h.deps.readMainWorktree = fail;
	await h.settle();
	expect(h.spaces).toBe(before);
	expect(h.errors.length).toBe(2);
	h.deps.readRegistry = async () => null;
	await h.settle();
	expect(h.spaces).toBe(before);
	h.deps.readRegistry = async () => ['STA-1', 'STA-2'];
	h.deps.readMainWorktree = async () => ({path: '/repo', branch: 'master'});
	h.deps.readDirty = async () => null;
	h.deps.statusReader = () => async () => null;
	h.deps.readWorktreePath = fail;
	h.deps.readEmoji = fail;
	await h.settle();
	expect(h.spaces).toBe(before);
	h.deps.readRegistry = async () => [];
	await h.settle();
	expect(h.spaces).toStrictEqual([before[0]!]);
});

test('stop suppresses late disk, tracker and hook publications', async () => {
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
	expect(h.spaces).toBe(before);
});

test('spaces list newest number first, and beads hash keys keep one order whatever the registry order', async () => {
	const order = async (registry: string[]) => {
		const h = setup({readRegistry: async () => registry});
		await h.settle();
		return h.spaces.filter(space => !space.isMainWorktree).map(s => s.name);
	};

	expect(await order(['STA-9', 'ABC-50', 'STA-12', 'STA-100'])).toStrictEqual([
		'STA-100',
		'ABC-50',
		'STA-12',
		'STA-9',
	]);
	const keys = ['fl-ec0', 'fl-1a2', 'fl-zz9', 'fl-x3'];
	expect(await order(keys)).toStrictEqual(await order([...keys].reverse()));
});
