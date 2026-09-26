import {mkdtempSync, rmSync, writeFileSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import {
	applyStatusUpdates,
	watchStatuses,
	type ClaudeStatusInfo,
} from './claude-status.ts';
import {ACTIVE_STATUS_TIMEOUT, type SpaceData} from './types.ts';

function statusDir(t: ExecutionContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'status-batch-'));
	const previous = process.env['PAPPARDELLE_STATUS_DIR'];
	process.env['PAPPARDELLE_STATUS_DIR'] = dir;
	t.teardown(() => {
		if (previous === undefined) delete process.env['PAPPARDELLE_STATUS_DIR'];
		else process.env['PAPPARDELLE_STATUS_DIR'] = previous;
		rmSync(dir, {recursive: true, force: true});
	});
	return dir;
}

function writeStatus(
	dir: string,
	name: string,
	info: ClaudeStatusInfo,
	lastUpdate = Date.now(),
) {
	const file = path.join(dir, `${name}.json`);
	writeFileSync(
		`${file}.tmp`,
		JSON.stringify({
			status: info.status,
			currentTool: info.tool,
			lastUpdate,
		}),
	);
	renameSync(`${file}.tmp`, file);
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Status update did not arrive');
		await delay(5);
	}
}

test.serial(
	'hook bursts coalesce by workspace and preserve the final approval tool',
	async t => {
		const dir = statusDir(t);
		const batches: Array<ReadonlyMap<string, ClaudeStatusInfo>> = [];
		const stop = watchStatuses(
			updates => batches.push(updates),
			name => name.startsWith('ours-'),
		);
		t.teardown(stop);
		const count = 32;
		for (let burst = 0; burst < 4; burst++) {
			for (let i = 0; i < count; i++) {
				writeStatus(dir, `ours-${i}`, {status: 'running_tool', tool: 'Bash'});
				writeStatus(dir, `other-${i}`, {status: 'processing'});
			}
			await delay(2);
		}
		for (let i = 0; i < count; i++) {
			writeStatus(dir, `ours-${i}`, {
				status: 'waiting_for_approval',
				tool: 'AskUserQuestion',
			});
		}
		await until(() =>
			batches.some(
				batch =>
					batch.size === count &&
					[...batch.values()].every(info => info.tool === 'AskUserQuestion'),
			),
		);
		t.true(
			batches.length <= 3,
			`Expected a few batches, received ${batches.length}`,
		);
		t.true(
			batches.every(batch =>
				[...batch.keys()].every(
					name => name.startsWith('ours-') && !name.includes('.tmp'),
				),
			),
		);
		t.deepEqual(batches.at(-1)?.get('ours-0'), {
			status: 'waiting_for_approval',
			tool: 'AskUserQuestion',
		});
	},
);

test.serial(
	'async watcher keeps stale, corrupt, deleted, and stable status semantics',
	async t => {
		const dir = statusDir(t);
		const latest = new Map<string, ClaudeStatusInfo>();
		const stop = watchStatuses(updates => {
			for (const [name, info] of updates) latest.set(name, info);
		});
		t.teardown(stop);
		const old = Date.now() - ACTIVE_STATUS_TIMEOUT - 1;
		writeStatus(dir, 'active', {status: 'processing'}, old);
		writeStatus(dir, 'stable', {status: 'waiting_for_input'}, old);
		writeFileSync(path.join(dir, 'corrupt.json'), '{');
		writeStatus(dir, 'deleted', {status: 'ended'});
		await until(() => latest.size === 4);
		t.deepEqual(latest.get('active'), {status: 'unknown'});
		t.deepEqual(latest.get('corrupt'), {status: 'unknown'});
		t.is(latest.get('stable')?.status, 'waiting_for_input');
		rmSync(path.join(dir, 'deleted.json'));
		await until(() => latest.get('deleted')?.status === 'unknown');
		t.deepEqual(latest.get('deleted'), {status: 'unknown'});
	},
);

test.serial('closing the watcher cancels queued updates', async t => {
	const dir = statusDir(t);
	let callbacks = 0;
	const stop = watchStatuses(() => callbacks++);
	t.teardown(stop);
	writeStatus(dir, 'workspace', {status: 'processing'});
	await delay(10);
	stop();
	await delay(80);
	t.is(callbacks, 0);
});

test('status batches preserve identity for unchanged rows and ignore other repositories', t => {
	const spaces: SpaceData[] = [
		{
			name: 'main',
			statusKey: 'repo-main',
			worktreePath: null,
			claudeStatus: 'processing',
		},
		{name: 'STA-1', worktreePath: null, claudeStatus: 'waiting_for_input'},
	];
	t.is(
		applyStatusUpdates(
			spaces,
			new Map([
				['main', {status: 'ended'}],
				['repo-main', {status: 'processing'}],
				['other-main', {status: 'error'}],
			]),
		),
		spaces,
	);
	const updated = applyStatusUpdates(
		spaces,
		new Map([
			['repo-main', {status: 'waiting_for_approval', tool: 'AskUserQuestion'}],
		]),
	);
	t.not(updated, spaces);
	t.is(updated[1], spaces[1]);
	t.is(updated[0]?.claudeTool, 'AskUserQuestion');
	t.is(spaces[0]?.claudeStatus, 'processing');
	const cleared = applyStatusUpdates(
		updated,
		new Map([['repo-main', {status: 'waiting_for_approval'}]]),
	);
	t.is(cleared[0]?.claudeTool, undefined);
	t.not(cleared[0], updated[0]);
});
