import {spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {
	publishSnapshot,
	snapshotFile,
	snapshotOf,
} from '../test/helpers/program-status.ts';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {WorkspaceStatuses} from './workspace-status.ts';
import {WorkspaceRefresh} from './workspace-refresh.ts';
import {
	parseStatusPane,
	type ProgramStatusDao,
	type ProgramStatusSnapshot,
	type StatusPane,
} from './program-status-monitor.ts';
import {statusSocketPath} from './state-db.ts';
import {
	mapClaudeStatus,
	ACTIVE_STATUS_TIMEOUT,
	type ClaudeStatus,
} from './claude-status.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import type {SpaceData} from './types.ts';

function setup(options: {sqlite?: boolean} = {}) {
	const oldSocket = process.env['PAPPARDELLE_TMUX_SOCKET'];
	process.env['PAPPARDELLE_TMUX_SOCKET'] = 'test-status';
	const state = testState(options);
	const {claudeStatus, programStatus} = state.daos;
	teardown(() => {
		if (oldSocket === undefined)
			Reflect.deleteProperty(process.env, 'PAPPARDELLE_TMUX_SOCKET');
		else process.env['PAPPARDELLE_TMUX_SOCKET'] = oldSocket;
	});
	let paneOutput = '%1\t12\t0\t1\t12.owner';
	let queries = 0;
	const status = new WorkspaceStatuses(
		programStatus,
		key => `claude-repo-${key}`,
		claudeStatus,
		async () => {
			queries++;
			return ['claude-repo-TASK-1', 'claude-repo-main']
				.map(session => `${session}\t1\t%1\t${paneOutput}`)
				.join('\n');
		},
	);
	const writeHook = async (
		status: ClaudeStatus,
		currentTool?: string,
		lastUpdate = Date.now(),
		key = 'TASK-1',
	) =>
		writeClaudeStatus(state, {
			sessionId: 'session',
			workspaceName: key,
			status,
			currentTool,
			lastUpdate,
		});
	const writeOsc = async (
		info: ProgramStatusInfo,
		options: {
			authoritative?: boolean;
			key?: string;
			repo?: string;
			age?: number;
			/** Change what is published, as a writer other than the monitor could. */
			tamper?: (snapshot: ProgramStatusSnapshot) => void;
		} = {},
	) => {
		const {status, ...details} = info;
		const snapshot = snapshotOf(
			{
				repo: options.repo ?? 'repo',
				key: options.key ?? 'TASK-1',
				pane: parseStatusPane(paneOutput, 'test-status')!,
			},
			status === 'unknown' ? [] : [{state: status, id: '', ...details}],
			{
				authoritative: options.authoritative ?? true,
				updatedAt: Date.now() - (options.age ?? 0),
			},
		);
		options.tamper?.(snapshot);
		return publishSnapshot(state, snapshot);
	};
	return {
		state,
		status,
		pane: () => parseStatusPane(paneOutput, 'test-status')!,
		writeHook,
		writeOsc,
		queries: () => queries,
		replacePane() {
			paneOutput = '%1\t13\t0\t1\t13.new';
		},
		exitPane() {
			paneOutput = '%1\t12\t1\t0\t12.owner';
		},
		/** tmux 3.8 lists no pid for a dead pane. */
		exitPaneWithoutPid() {
			paneOutput = '%1\t\t1\t0\t12.owner';
		},
	};
}

test('hook mapping preserves question and compaction semantics without implying completion on exit', () => {
	expect(
		mapClaudeStatus({status: 'waiting_for_approval', tool: 'AskUserQuestion'}),
	).toMatchObject({status: 'blocked', kind: 'question', source: 'hook'});
	expect(
		mapClaudeStatus({status: 'waiting_for_approval', tool: 'Bash'}),
	).toMatchObject({
		status: 'blocked',
		kind: 'permission',
	});
	expect(mapClaudeStatus({status: 'compacting'})).toMatchObject({
		status: 'working',
		activity: 'compacting',
	});
	expect(mapClaudeStatus({status: 'ended'}).status).toBe('idle');
});

for (const exit of ['exitPane', 'exitPaneWithoutPid'] as const) {
	test(`dead panes remove active records immediately while retaining done and error (${exit})`, async () => {
		const h = setup();
		await h.writeHook('waiting_for_input');
		await h.writeOsc({status: 'working', app: 'fixture'});
		h[exit]();
		expect(await h.status.read('TASK-1')).toMatchObject({
			status: 'unknown',
			source: 'osc',
		});
		for (const status of ['done', 'error'] as const) {
			await h.writeOsc({status, app: 'fixture'});
			expect(await h.status.read('TASK-1')).toMatchObject({
				status,
				source: 'osc',
			});
		}
	});
}

test('persisted status cannot inject invalid fields or contradict its records', async () => {
	const h = setup();
	await h.writeHook('waiting_for_input');
	for (const change of [
		(snapshot: ProgramStatusSnapshot) => {
			snapshot.info.status = 'blocked';
		},
		(snapshot: ProgramStatusSnapshot) => {
			snapshot.records[0]!.message = 'bad\ntext';
		},
		(snapshot: ProgramStatusSnapshot) => {
			snapshot.records[0]!.id = 'invalid//id';
		},
	]) {
		await h.writeOsc({status: 'working', app: 'fixture'}, {tamper: change});
		expect(await h.status.read('TASK-1')).toMatchObject({
			status: 'idle',
			source: 'hook',
		});
	}
});

test('native records remain authoritative past ten minutes and through conflicting hook writes and clear', async () => {
	const h = setup();
	await h.writeHook('processing');
	expect(await readField(h.status, 'TASK-1', 'source')).toBe('hook');
	await h.writeOsc(
		{status: 'blocked', kind: 'auth', app: 'codex'},
		{age: ACTIVE_STATUS_TIMEOUT * 2},
	);
	await h.writeHook('waiting_for_input');
	expect(await h.status.read('TASK-1')).toMatchObject({
		status: 'blocked',
		kind: 'auth',
		app: 'codex',
		source: 'osc',
	});
	await h.writeOsc({status: 'unknown'});
	expect(await h.status.read('TASK-1')).toMatchObject({
		status: 'unknown',
		source: 'osc',
	});
});

test('query alone leaves hooks active and matching hook details do not cross app, record or state', async () => {
	const h = setup();
	await h.writeHook('running_tool', 'Bash');
	await h.writeOsc({status: 'unknown'}, {authoritative: false});
	expect(await h.status.read('TASK-1')).toMatchObject({
		status: 'working',
		source: 'hook',
		tool: 'Bash',
	});
	await h.writeOsc({status: 'working', app: 'claude-code', id: ''});
	expect(await readField(h.status, 'TASK-1', 'tool')).toBe('Bash');
	for (const info of [
		{status: 'idle', app: 'claude-code'},
		{status: 'working', app: 'other'},
		{status: 'working', app: 'claude-code', id: 'child'},
	] as ProgramStatusInfo[]) {
		await h.writeOsc(info);
		expect(await readField(h.status, 'TASK-1', 'tool')).toBe(undefined);
	}
});

test('new pane identities reject late old snapshots and same keys in other repositories', async () => {
	const h = setup();
	await h.writeHook('waiting_for_input');
	await h.writeOsc({status: 'error'});
	h.replacePane();
	expect(await h.status.read('TASK-1')).toMatchObject({
		status: 'idle',
		source: 'hook',
	});
	await h.writeOsc({status: 'blocked'}, {repo: 'other'});
	expect(await readField(h.status, 'TASK-1', 'source')).toBe('hook');
});

test('main workspace OSC uses its stable session key while the hook follows its branch', async () => {
	const h = setup();
	await h.writeHook('waiting_for_input', undefined, Date.now(), 'repo-main');
	await h.writeOsc({status: 'working', app: 'claude-code'}, {key: 'main'});
	expect(await h.status.read('repo-main', 'main')).toMatchObject({
		status: 'working',
		source: 'osc',
	});
});

test('both status sources trigger resolved updates and closing cancels queued publications', async () => {
	const h = setup();
	await h.status.read('TASK-1');
	const batches: Array<ReadonlyMap<string, ProgramStatusInfo>> = [];
	let published: () => void = () => {};
	const nextPublication = async () =>
		new Promise<void>(resolve => {
			published = resolve;
		});
	const stop = h.status.watch(
		updates => {
			batches.push(updates);
			published();
		},
		key => key === 'TASK-1',
	);
	teardown(stop);
	// The first fixture write can otherwise precede filesystem watch registration.
	await delay(0);
	const hookPublished = nextPublication();
	await h.writeHook('processing');
	await hookPublished;
	expect(batches.at(-1)?.get('TASK-1')?.source).toBe('hook');
	const donePublished = nextPublication();
	await h.writeOsc({status: 'done', app: 'claude-code'});
	await donePublished;
	expect(batches.at(-1)?.get('TASK-1')?.status).toBe('done');
	const before = batches.length;
	await h.writeHook('error');
	stop();
	await delay(100);
	expect(batches.length).toBe(before);
}, 5000);

test('known native updates avoid discovery while full reads reconcile generations', async () => {
	const h = setup();
	await h.writeOsc({status: 'working', app: 'fixture'});
	await h.status.read('TASK-1');
	const latest = new Map<string, ProgramStatusInfo>();
	const stop = h.status.watch(
		updates => {
			for (const [key, info] of updates) latest.set(key, info);
		},
		key => key === 'TASK-1',
	);
	teardown(stop);
	await delay(0);
	const before = h.queries();
	await h.writeOsc({status: 'blocked', app: 'fixture', kind: 'auth'});
	await waitUntil(
		() => latest.get('TASK-1')?.status === 'blocked',
		'a status update',
	);
	await h.writeHook('processing');
	await delay(100);
	expect(h.queries()).toBe(before);
	expect(latest.get('TASK-1')?.status).toBe('blocked');
	const oldGeneration = latest.get('TASK-1')?.generation;
	h.replacePane();
	await h.writeOsc({status: 'done', app: 'replacement'});
	await h.status.read('TASK-1');
	await h.writeHook('error');
	await waitUntil(
		() => latest.get('TASK-1')?.app === 'replacement',
		'a status update',
	);
	expect(latest.get('TASK-1')?.generation).not.toBe(oldGeneration);
	expect(h.queries() > before).toBe(true);
});

test('hook bursts reach only relevant workspaces and preserve the final question tool', async () => {
	const h = setup();
	const latest = new Map<string, ProgramStatusInfo>();
	const stop = h.status.watch(
		updates => {
			for (const [key, info] of updates) latest.set(key, info);
		},
		key => key.startsWith('ours-'),
	);
	teardown(stop);
	await delay(0);
	for (let burst = 0; burst < 3; burst++) {
		for (let i = 0; i < 8; i++) {
			await h.writeHook('running_tool', 'Bash', Date.now(), `ours-${i}`);
			await h.writeHook('processing', undefined, Date.now(), `other-${i}`);
		}
	}
	for (let i = 0; i < 8; i++)
		await h.writeHook(
			'waiting_for_approval',
			'AskUserQuestion',
			Date.now(),
			`ours-${i}`,
		);
	await waitUntil(
		() =>
			latest.size === 8 &&
			[...latest.values()].every(info => info.status === 'blocked'),
		'a status update',
	);
	for (const [key, info] of latest) {
		expect(key.startsWith('ours-')).toBe(true);
		expect(info).toMatchObject({
			source: 'hook',
			status: 'blocked',
			kind: 'question',
			tool: 'AskUserQuestion',
		});
	}
});

test('main snapshot events retain their UI alias and revoked leases trigger discovery', async () => {
	const h = setup();
	const file = await h.writeOsc({status: 'working'}, {key: 'main'});
	await h.status.read('repo-main', 'main');
	const latest = new Map<string, ProgramStatusInfo>();
	const stop = h.status.watch(
		updates => {
			for (const [key, info] of updates) latest.set(key, info);
		},
		key => key === 'repo-main',
	);
	teardown(stop);
	await delay(0);
	const before = h.queries();
	await h.writeOsc({status: 'done'}, {key: 'main'});
	await waitUntil(
		() => latest.get('repo-main')?.status === 'done',
		'a status update',
	);
	expect(h.queries()).toBe(before);
	expect(latest.has('main')).toBe(false);
	rmSync(`${file}.lease`);
	await h.writeHook('processing', undefined, Date.now(), 'repo-main');
	await waitUntil(() => h.queries() > before, 'a status update');
});

test('a refresh locates every space with one tmux call and pipes only unmonitored live panes', async () => {
	const {state} = setup();
	const keys = Array.from({length: 11}, (_, i) => `TASK-${i + 1}`);
	const piped = new Set([...keys.slice(1), 'main']);
	const calls: string[][] = [];
	const listing = () =>
		[...keys, 'main']
			.map((key, i) => {
				const pane = `%${i + 1}`;
				const pid = String(100 + i);
				const pipe = piped.has(key) ? '1' : '0';
				const dead = key === 'TASK-11' ? '1' : '0';
				const pinned = piped.has(key) ? pane : '';
				return `agent-${key}\t1\t${pinned}\t${pane}\t${pid}\t${dead}\t${pipe}\t`;
			})
			.join('\n');
	const statuses = new WorkspaceStatuses(
		state.daos.programStatus,
		key => `agent-${key}`,
		state.daos.claudeStatus,
		async args => {
			calls.push(args);
			return args.includes('list-panes') ? listing() : '';
		},
	);
	let spaces: SpaceData[] = [];
	const refresh = new WorkspaceRefresh({
		readRegistry: async () => keys,
		statusReader: () => statuses.reader(),
		readWorktreePath: async () => null,
		readMainWorktree: async () => ({path: '/repo', branch: 'main'}),
		readDirty: async () => null,
		statusKey: name => name,
		getCachedIssue: () => null,
		async fetchIssues() {},
		readEmoji: async () => undefined,
		setSpaces(update) {
			spaces = update(spaces);
		},
		onLoaded() {},
		onError(error) {
			throw error;
		},
	});
	teardown(() => refresh.stop());
	const commands = () => calls.map(args => args[2]);

	await refresh.refresh();
	await refresh.idle();
	// The first space's pane is pinned and piped in one call.
	expect(commands()).toStrictEqual(['list-panes', 'if-shell']);
	expect(calls[1]!.some(arg => arg.includes("'=agent-TASK-1:'"))).toBe(true);
	expect(spaces.length).toBe(12);

	piped.add('TASK-1');
	for (const _ of [1, 2]) {
		calls.length = 0;
		await refresh.refresh();
		await refresh.idle();
		expect(commands()).toStrictEqual(['list-panes']);
	}

	calls.length = 0;
	await Promise.all(Array.from({length: 20}, async () => refresh.refresh()));
	await refresh.idle();
	expect(commands().length <= 2).toBe(true);
	expect(commands().every(command => command === 'list-panes')).toBe(true);
});

// A status read is a question to another process when the daemon holds the
// status, so a pane can be replaced while one is in progress.
test('a watched read that a newer attach overtook reads the newer pane, and attaches nothing more', async () => {
	const first = parseStatusPane('%1\t12\t0\t1\t12.first', 'test-status')!;
	const second = parseStatusPane('%1\t13\t0\t1\t13.second', 'test-status')!;
	const attached: StatusPane[] = [];
	let answerHeldRead: ((snapshot: null) => void) | undefined;
	let holdNextRead = false;
	let snapshotChanged: (key: string) => void = () => {};
	const attach = async () => {
		const pane = attached.length === 0 ? first : second;
		attached.push(pane);
		return pane;
	};
	const programStatus: ProgramStatusDao = {
		attach,
		monitor: attach,
		monitored: () => true,
		async read(key, pane) {
			if (holdNextRead) {
				holdNextRead = false;
				return new Promise(resolve => {
					answerHeldRead = resolve;
				});
			}

			return snapshotOf({repo: 'repo', key, pane}, [
				{state: 'working', id: ''},
			]);
		},
		async remove() {},
		watch(listener) {
			snapshotChanged = listener;
			return () => {};
		},
		async waitForChange() {},
	};
	const statuses = new WorkspaceStatuses(programStatus, key => key, {
		read: async () => ({status: 'unknown'}),
		watch: () => () => {},
	});
	await statuses.read('TASK-1');
	const delivered: Array<string | undefined> = [];
	teardown(
		statuses.watch(
			updates => delivered.push(updates.get('TASK-1')?.generation),
			() => true,
		),
	);

	holdNextRead = true;
	snapshotChanged('TASK-1');
	await waitUntil(() => answerHeldRead !== undefined, 'the watched read');
	await statuses.read('TASK-1');
	answerHeldRead!(null);

	await waitUntil(() => delivered.length > 0, 'the status update');
	expect(delivered).toStrictEqual([second.generation]);
	expect(attached).toStrictEqual([first, second]);
});

const monitorCli = fileURLToPath(
	new URL('program-status-monitor-cli.ts', import.meta.url),
);

// A pane's monitor is another process than the rail that shows its status.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a status published by a pane's monitor reaches a watching rail`, async () => {
		const h = setup({sqlite});
		const pane = h.pane();
		const file = snapshotFile(h.state, {repo: 'repo', key: 'TASK-1', pane});
		mkdirSync(path.dirname(file), {recursive: true});
		writeFileSync(`${file}.lease`, '');
		const monitor = spawn(
			process.execPath,
			[
				monitorCli,
				'watch',
				'repo',
				'TASK-1',
				Buffer.from(JSON.stringify(pane)).toString('base64'),
				path.dirname(file),
				'',
				statusSocketPath(h.state.stateDir),
			],
			{
				stdio: ['pipe', 'ignore', 'inherit'],
				env: {
					...process.env,
					HOME: h.state.stateDir,
					PAPPARDELLE_SQLITE_STATE: sqlite ? '1' : '0',
				},
			},
		);
		teardown(() => {
			monitor.kill('SIGKILL');
		});
		await h.status.read('TASK-1');
		const latest = new Map<string, ProgramStatusInfo>();
		const stop = h.status.watch(
			updates => {
				for (const [key, info] of updates) latest.set(key, info);
			},
			key => key === 'TASK-1',
		);
		teardown(stop);
		await delay(0);
		monitor.stdin.write(
			'\u001B]7501;state=blocked:app=fixture:kind=auth\u0007',
		);
		await waitUntil(
			() => latest.get('TASK-1')?.status === 'blocked',
			'a status update',
			10_000,
		);
		expect(latest.get('TASK-1')).toMatchObject({
			source: 'osc',
			app: 'fixture',
			kind: 'auth',
		});
		rmSync(`${file}.lease`);
	});
}

async function readField(
	status: WorkspaceStatuses,
	key: string,
	field: keyof ProgramStatusInfo,
) {
	const info = await status.read(key);
	return info?.[field];
}

test("a space's session name is looked up once, however often its status is read", async () => {
	const state = testState();
	let lookups = 0;
	const statuses = new WorkspaceStatuses(
		state.daos.programStatus,
		key => {
			lookups++;
			return `agent-repo-${key}`;
		},
		state.daos.claudeStatus,
		async () => '',
	);
	for (let read = 0; read < 3; read++) {
		// eslint-disable-next-line no-await-in-loop -- Reads in turn, as refreshes do.
		await statuses.read('TASK-1');
	}

	expect(lookups).toBe(1);
});
