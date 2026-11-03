import {
	mkdirSync,
	readFileSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	renameSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import {WorkspaceStatuses} from './workspace-status.ts';
import {
	parseStatusPane,
	programStatusPath,
	type ProgramStatusSnapshot,
} from './program-status-monitor.ts';
import {mapClaudeStatus, ACTIVE_STATUS_TIMEOUT} from './claude-status.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import {ProgramStatusStore} from './program-status.ts';

function setup(t: ExecutionContext) {
	const dir = mkdtempSync(path.join(tmpdir(), 'workspace-status-'));
	const oldHook = process.env['PAPPARDELLE_STATUS_DIR'];
	const oldOsc = process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'];
	const oldSocket = process.env['PAPPARDELLE_TMUX_SOCKET'];
	process.env['PAPPARDELLE_STATUS_DIR'] = path.join(dir, 'hooks');
	process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'] = path.join(dir, 'osc');
	process.env['PAPPARDELLE_TMUX_SOCKET'] = 'test-status';
	mkdirSync(path.join(dir, 'hooks'));
	t.teardown(() => {
		for (const [key, value] of [
			['PAPPARDELLE_STATUS_DIR', oldHook],
			['PAPPARDELLE_PROGRAM_STATUS_DIR', oldOsc],
			['PAPPARDELLE_TMUX_SOCKET', oldSocket],
		]) {
			if (value === undefined) Reflect.deleteProperty(process.env, key!);
			else process.env[key!] = value;
		}
		rmSync(dir, {recursive: true, force: true});
	});
	let paneOutput = '%1\t12\t0\t1\t12.owner';
	let queries = 0;
	const status = new WorkspaceStatuses(
		'repo',
		key => `claude-repo-${key}`,
		async args => {
			queries++;
			return args.includes('show-option') ? '%1' : paneOutput;
		},
	);
	const writeHook = (
		status: string,
		currentTool?: string,
		lastUpdate = Date.now(),
		key = 'TASK-1',
	) => {
		writeFileSync(
			path.join(dir, 'hooks', `${key}.json`),
			JSON.stringify({status, currentTool, lastUpdate}),
		);
	};
	const writeOsc = (
		info: ProgramStatusInfo,
		options: {
			authoritative?: boolean;
			key?: string;
			repo?: string;
			age?: number;
		} = {},
	) => {
		const pane = parseStatusPane(paneOutput, 'test-status')!;
		const key = options.key ?? 'TASK-1';
		const repo = options.repo ?? 'repo';
		const file = programStatusPath(repo, key, pane.generation);
		mkdirSync(path.dirname(file), {recursive: true});
		const store = new ProgramStatusStore();
		if (info.status !== 'unknown') {
			const {status, ...details} = info;
			store.apply({state: status, id: '', ...details});
		}
		const snapshot: ProgramStatusSnapshot = {
			version: 1,
			repo,
			key,
			pane,
			authoritative: options.authoritative ?? true,
			exited: false,
			updatedAt: Date.now() - (options.age ?? 0),
			records: store.records(),
			info: store.status(),
		};
		writeFileSync(`${file}.tmp`, JSON.stringify(snapshot));
		renameSync(`${file}.tmp`, file);
		writeFileSync(`${file}.lease`, '');
		return file;
	};
	return {
		status,
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
		h.writeHook('waiting_for_input');
		h.writeOsc({status: 'working', app: 'fixture'});
		h.exitPane();
		t.like(await h.status.read('TASK-1'), {status: 'unknown', source: 'osc'});
		for (const status of ['done', 'error'] as const) {
			h.writeOsc({status, app: 'fixture'});
			t.like(await h.status.read('TASK-1'), {status, source: 'osc'});
		}
	},
);

test.serial(
	'persisted status cannot inject invalid fields or contradict its records',
	async t => {
		const h = setup(t);
		h.writeHook('waiting_for_input');
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
			const file = h.writeOsc({status: 'working', app: 'fixture'});
			const snapshot = JSON.parse(
				readFileSync(file, 'utf8'),
			) as ProgramStatusSnapshot;
			change(snapshot);
			writeFileSync(file, JSON.stringify(snapshot));
			t.like(await h.status.read('TASK-1'), {status: 'idle', source: 'hook'});
		}
	},
);

test.serial(
	'native records remain authoritative past ten minutes and through conflicting hook writes and clear',
	async t => {
		const h = setup(t);
		h.writeHook('processing');
		t.is(await readField(h.status, 'TASK-1', 'source'), 'hook');
		h.writeOsc(
			{status: 'blocked', kind: 'auth', app: 'codex'},
			{age: ACTIVE_STATUS_TIMEOUT * 2},
		);
		h.writeHook('waiting_for_input');
		t.like(await h.status.read('TASK-1'), {
			status: 'blocked',
			kind: 'auth',
			app: 'codex',
			source: 'osc',
		});
		h.writeOsc({status: 'unknown'});
		t.like(await h.status.read('TASK-1'), {status: 'unknown', source: 'osc'});
	},
);

test.serial(
	'query alone leaves hooks active and matching hook details do not cross app, record or state',
	async t => {
		const h = setup(t);
		h.writeHook('running_tool', 'Bash');
		h.writeOsc({status: 'unknown'}, {authoritative: false});
		t.like(await h.status.read('TASK-1'), {
			status: 'working',
			source: 'hook',
			tool: 'Bash',
		});
		h.writeOsc({status: 'working', app: 'claude-code', id: ''});
		t.is(await readField(h.status, 'TASK-1', 'tool'), 'Bash');
		for (const info of [
			{status: 'idle', app: 'claude-code'},
			{status: 'working', app: 'other'},
			{status: 'working', app: 'claude-code', id: 'child'},
		] as ProgramStatusInfo[]) {
			h.writeOsc(info);
			t.is(await readField(h.status, 'TASK-1', 'tool'), undefined);
		}
	},
);

test.serial(
	'new pane identities reject late old snapshots and same keys in other repositories',
	async t => {
		const h = setup(t);
		h.writeHook('waiting_for_input');
		h.writeOsc({status: 'error'});
		h.replacePane();
		t.like(await h.status.read('TASK-1'), {status: 'idle', source: 'hook'});
		h.writeOsc({status: 'blocked'}, {repo: 'other'});
		t.is(await readField(h.status, 'TASK-1', 'source'), 'hook');
	},
);

test.serial(
	'main workspace OSC uses its stable session key while the hook follows its branch',
	async t => {
		const h = setup(t);
		h.writeHook('waiting_for_input', undefined, Date.now(), 'repo-main');
		h.writeOsc({status: 'working', app: 'claude-code'}, {key: 'main'});
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
		h.writeHook('processing');
		await hookPublished;
		t.is(batches.at(-1)?.get('TASK-1')?.source, 'hook');
		const donePublished = nextPublication();
		h.writeOsc({status: 'done', app: 'claude-code'});
		await donePublished;
		t.is(batches.at(-1)?.get('TASK-1')?.status, 'done');
		const before = batches.length;
		h.writeHook('error');
		stop();
		await delay(100);
		t.is(batches.length, before);
	},
);

test.serial(
	'known native updates avoid discovery while full reads reconcile generations',
	async t => {
		const h = setup(t);
		h.writeOsc({status: 'working', app: 'fixture'});
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
		h.writeOsc({status: 'blocked', app: 'fixture', kind: 'auth'});
		await until(() => latest.get('TASK-1')?.status === 'blocked');
		h.writeHook('processing');
		await delay(100);
		t.is(h.queries(), before);
		t.is(latest.get('TASK-1')?.status, 'blocked');
		const oldGeneration = latest.get('TASK-1')?.generation;
		h.replacePane();
		h.writeOsc({status: 'done', app: 'replacement'});
		await h.status.read('TASK-1');
		h.writeHook('error');
		await until(() => latest.get('TASK-1')?.app === 'replacement');
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
				h.writeHook('running_tool', 'Bash', Date.now(), `ours-${i}`);
				h.writeHook('processing', undefined, Date.now(), `other-${i}`);
			}
		}
		for (let i = 0; i < 8; i++)
			h.writeHook(
				'waiting_for_approval',
				'AskUserQuestion',
				Date.now(),
				`ours-${i}`,
			);
		await until(
			() =>
				latest.size === 8 &&
				[...latest.values()].every(info => info.status === 'blocked'),
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
		const file = h.writeOsc({status: 'working'}, {key: 'main'});
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
		h.writeOsc({status: 'done'}, {key: 'main'});
		await until(() => latest.get('repo-main')?.status === 'done');
		t.is(h.queries(), before);
		t.false(latest.has('main'));
		rmSync(`${file}.lease`);
		h.writeHook('processing', undefined, Date.now(), 'repo-main');
		await until(() => h.queries() > before);
	},
);

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Status update did not arrive');
		await delay(5);
	}
}

async function readField(
	status: WorkspaceStatuses,
	key: string,
	field: keyof ProgramStatusInfo,
) {
	const info = await status.read(key);
	return info?.[field];
}
