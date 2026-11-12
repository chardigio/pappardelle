import {spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import test, {type ExecutionContext} from 'ava';
import {
	publishSnapshot,
	snapshotFile,
	snapshotOf,
} from '../test/helpers/program-status.ts';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {WorkspaceStatuses} from './workspace-status.ts';
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

function setup(t: ExecutionContext, options: {sqlite?: boolean} = {}) {
	const oldSocket = process.env['PAPPARDELLE_TMUX_SOCKET'];
	process.env['PAPPARDELLE_TMUX_SOCKET'] = 'test-status';
	const state = testState(t, options);
	const {claudeStatus, programStatus} = state.daos;
	t.teardown(() => {
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
		async args => {
			queries++;
			return `%1\t${paneOutput}`;
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
	};
}

test('hook mapping preserves question and compaction semantics without implying completion on exit', t => {
	t.like(
		mapClaudeStatus({status: 'waiting_for_approval', tool: 'AskUserQuestion'}),
		{status: 'blocked', kind: 'question', source: 'hook'},
	);
	t.like(mapClaudeStatus({status: 'waiting_for_approval', tool: 'Bash'}), {
		status: 'blocked',
		kind: 'permission',
	});
	t.like(mapClaudeStatus({status: 'compacting'}), {
		status: 'working',
		activity: 'compacting',
	});
	t.is(mapClaudeStatus({status: 'ended'}).status, 'idle');
});

test.serial(
	'dead panes remove active records immediately while retaining done and error',
	async t => {
		const h = setup(t);
		await h.writeHook('waiting_for_input');
		await h.writeOsc({status: 'working', app: 'fixture'});
		h.exitPane();
		t.like(await h.status.read('TASK-1'), {status: 'unknown', source: 'osc'});
		for (const status of ['done', 'error'] as const) {
			await h.writeOsc({status, app: 'fixture'});
			t.like(await h.status.read('TASK-1'), {status, source: 'osc'});
		}
	},
);

test.serial(
	'persisted status cannot inject invalid fields or contradict its records',
	async t => {
		const h = setup(t);
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
			t.like(await h.status.read('TASK-1'), {status: 'idle', source: 'hook'});
		}
	},
);

test.serial(
	'native records remain authoritative past ten minutes and through conflicting hook writes and clear',
	async t => {
		const h = setup(t);
		await h.writeHook('processing');
		t.is(await readField(h.status, 'TASK-1', 'source'), 'hook');
		await h.writeOsc(
			{status: 'blocked', kind: 'auth', app: 'codex'},
			{age: ACTIVE_STATUS_TIMEOUT * 2},
		);
		await h.writeHook('waiting_for_input');
		t.like(await h.status.read('TASK-1'), {
			status: 'blocked',
			kind: 'auth',
			app: 'codex',
			source: 'osc',
		});
		await h.writeOsc({status: 'unknown'});
		t.like(await h.status.read('TASK-1'), {status: 'unknown', source: 'osc'});
	},
);

test.serial(
	'query alone leaves hooks active and matching hook details do not cross app, record or state',
	async t => {
		const h = setup(t);
		await h.writeHook('running_tool', 'Bash');
		await h.writeOsc({status: 'unknown'}, {authoritative: false});
		t.like(await h.status.read('TASK-1'), {
			status: 'working',
			source: 'hook',
			tool: 'Bash',
		});
		await h.writeOsc({status: 'working', app: 'claude-code', id: ''});
		t.is(await readField(h.status, 'TASK-1', 'tool'), 'Bash');
		for (const info of [
			{status: 'idle', app: 'claude-code'},
			{status: 'working', app: 'other'},
			{status: 'working', app: 'claude-code', id: 'child'},
		] as ProgramStatusInfo[]) {
			await h.writeOsc(info);
			t.is(await readField(h.status, 'TASK-1', 'tool'), undefined);
		}
	},
);

test.serial(
	'new pane identities reject late old snapshots and same keys in other repositories',
	async t => {
		const h = setup(t);
		await h.writeHook('waiting_for_input');
		await h.writeOsc({status: 'error'});
		h.replacePane();
		t.like(await h.status.read('TASK-1'), {status: 'idle', source: 'hook'});
		await h.writeOsc({status: 'blocked'}, {repo: 'other'});
		t.is(await readField(h.status, 'TASK-1', 'source'), 'hook');
	},
);

test.serial(
	'main workspace OSC uses its stable session key while the hook follows its branch',
	async t => {
		const h = setup(t);
		await h.writeHook('waiting_for_input', undefined, Date.now(), 'repo-main');
		await h.writeOsc({status: 'working', app: 'claude-code'}, {key: 'main'});
		t.like(await h.status.read('repo-main', 'main'), {
			status: 'working',
			source: 'osc',
		});
	},
);

test.serial(
	'both status sources trigger resolved updates and closing cancels queued publications',
	async t => {
		t.timeout(5000);
		const h = setup(t);
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
		t.teardown(stop);
		// The first fixture write can otherwise precede filesystem watch registration.
		await delay(0);
		const hookPublished = nextPublication();
		await h.writeHook('processing');
		await hookPublished;
		t.is(batches.at(-1)?.get('TASK-1')?.source, 'hook');
		const donePublished = nextPublication();
		await h.writeOsc({status: 'done', app: 'claude-code'});
		await donePublished;
		t.is(batches.at(-1)?.get('TASK-1')?.status, 'done');
		const before = batches.length;
		await h.writeHook('error');
		stop();
		await delay(100);
		t.is(batches.length, before);
	},
);

test.serial(
	'known native updates avoid discovery while full reads reconcile generations',
	async t => {
		const h = setup(t);
		await h.writeOsc({status: 'working', app: 'fixture'});
		await h.status.read('TASK-1');
		const latest = new Map<string, ProgramStatusInfo>();
		const stop = h.status.watch(
			updates => {
				for (const [key, info] of updates) latest.set(key, info);
			},
			key => key === 'TASK-1',
		);
		t.teardown(stop);
		await delay(0);
		const before = h.queries();
		await h.writeOsc({status: 'blocked', app: 'fixture', kind: 'auth'});
		await waitUntil(
			() => latest.get('TASK-1')?.status === 'blocked',
			'a status update',
		);
		await h.writeHook('processing');
		await delay(100);
		t.is(h.queries(), before);
		t.is(latest.get('TASK-1')?.status, 'blocked');
		const oldGeneration = latest.get('TASK-1')?.generation;
		h.replacePane();
		await h.writeOsc({status: 'done', app: 'replacement'});
		await h.status.read('TASK-1');
		await h.writeHook('error');
		await waitUntil(
			() => latest.get('TASK-1')?.app === 'replacement',
			'a status update',
		);
		t.not(latest.get('TASK-1')?.generation, oldGeneration);
		t.true(h.queries() > before);
	},
);

test.serial(
	'hook bursts reach only relevant workspaces and preserve the final question tool',
	async t => {
		const h = setup(t);
		const latest = new Map<string, ProgramStatusInfo>();
		const stop = h.status.watch(
			updates => {
				for (const [key, info] of updates) latest.set(key, info);
			},
			key => key.startsWith('ours-'),
		);
		t.teardown(stop);
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
			t.true(key.startsWith('ours-'));
			t.like(info, {
				source: 'hook',
				status: 'blocked',
				kind: 'question',
				tool: 'AskUserQuestion',
			});
		}
	},
);

test.serial(
	'main snapshot events retain their UI alias and revoked leases trigger discovery',
	async t => {
		const h = setup(t);
		const file = await h.writeOsc({status: 'working'}, {key: 'main'});
		await h.status.read('repo-main', 'main');
		const latest = new Map<string, ProgramStatusInfo>();
		const stop = h.status.watch(
			updates => {
				for (const [key, info] of updates) latest.set(key, info);
			},
			key => key === 'repo-main',
		);
		t.teardown(stop);
		await delay(0);
		const before = h.queries();
		await h.writeOsc({status: 'done'}, {key: 'main'});
		await waitUntil(
			() => latest.get('repo-main')?.status === 'done',
			'a status update',
		);
		t.is(h.queries(), before);
		t.false(latest.has('main'));
		rmSync(`${file}.lease`);
		await h.writeHook('processing', undefined, Date.now(), 'repo-main');
		await waitUntil(() => h.queries() > before, 'a status update');
	},
);

// A status read is a question to another process when the daemon holds the
// status, so a pane can be replaced while one is in progress.
test('a watched read that a newer attach overtook reads the newer pane, and attaches nothing more', async t => {
	const first = parseStatusPane('%1\t12\t0\t1\t12.first', 'test-status')!;
	const second = parseStatusPane('%1\t13\t0\t1\t13.second', 'test-status')!;
	const attached: StatusPane[] = [];
	let answerHeldRead: ((snapshot: null) => void) | undefined;
	let holdNextRead = false;
	let snapshotChanged: (key: string) => void = () => {};
	const programStatus: ProgramStatusDao = {
		async attach() {
			const pane = attached.length === 0 ? first : second;
			attached.push(pane);
			return pane;
		},
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
	t.teardown(
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
	t.deepEqual(delivered, [second.generation]);
	t.deepEqual(attached, [first, second]);
});

const monitorCli = fileURLToPath(
	new URL('program-status-monitor-cli.ts', import.meta.url),
);

// A pane's monitor is another process than the rail that shows its status.
for (const sqlite of [false, true]) {
	test.serial(
		`${sqlite ? 'sqlite' : 'json'}: a status published by a pane's monitor reaches a watching rail`,
		async t => {
			const h = setup(t, {sqlite});
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
					'test-status',
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
			t.teardown(() => {
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
			t.teardown(stop);
			await delay(0);
			monitor.stdin.write(
				'\u001B]7501;state=blocked:app=fixture:kind=auth\u0007',
			);
			await waitUntil(
				() => latest.get('TASK-1')?.status === 'blocked',
				'a status update',
				10_000,
			);
			t.like(latest.get('TASK-1'), {
				source: 'osc',
				app: 'fixture',
				kind: 'auth',
			});
			rmSync(`${file}.lease`);
		},
	);
}

async function readField(
	status: WorkspaceStatuses,
	key: string,
	field: keyof ProgramStatusInfo,
) {
	const info = await status.read(key);
	return info?.[field];
}
