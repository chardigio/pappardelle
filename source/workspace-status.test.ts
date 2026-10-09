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
	const status = new WorkspaceStatuses(
		'repo',
		key => `claude-repo-${key}`,
		async () => paneOutput,
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
		return file;
	};
	return {
		status,
		writeHook,
		writeOsc,
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
		const h = setup(t);
		await h.status.read('TASK-1');
		const batches: Array<ReadonlyMap<string, ProgramStatusInfo>> = [];
		const stop = h.status.watch(
			updates => batches.push(updates),
			key => key === 'TASK-1',
		);
		t.teardown(stop);
		h.writeHook('processing');
		await delay(150);
		t.is(batches.at(-1)?.get('TASK-1')?.source, 'hook');
		h.writeOsc({status: 'done', app: 'claude-code'});
		await delay(150);
		t.is(batches.at(-1)?.get('TASK-1')?.status, 'done');
		const before = batches.length;
		h.writeHook('error');
		stop();
		await delay(100);
		t.is(batches.length, before);
	},
);

async function readField(
	status: WorkspaceStatuses,
	key: string,
	field: keyof ProgramStatusInfo,
) {
	const info = await status.read(key);
	return info?.[field];
}
