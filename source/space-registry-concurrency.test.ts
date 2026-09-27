import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'ava';
import {
	setRegistryPath,
	resetRegistryPath,
	addSpace,
	removeSpace,
	getRegisteredSpaces,
	tryReserveWatchlistSlots,
	releaseWatchlistReservation,
	setLockTimingForTests,
	resetLockTimingForTests,
} from './space-registry.ts';
import {StartupQueue} from './startup-queue.ts';

const exec = promisify(execFile);
const registryUrl = new URL('space-registry.ts', import.meta.url).href;

function fixture(t: {teardown: (fn: () => void) => void}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-registry-race-'));
	const file = path.join(dir, 'open-spaces.json');
	setRegistryPath(file);
	t.teardown(() => {
		resetRegistryPath();
		resetLockTimingForTests();
		fs.rmSync(dir, {recursive: true, force: true});
	});
	return {dir, file};
}

test.serial(
	'two processes add, remove and reserve without losing updates or exceeding capacity',
	async t => {
		const {file, dir} = fixture(t);
		const worker = async (prefix: string) =>
			exec(
				process.execPath,
				[
					'--import',
					'tsx',
					'--input-type=module',
					'-e',
					`
import {setRegistryPath, addSpace, removeSpace, tryReserveWatchlistSlots} from ${JSON.stringify(registryUrl)};
setRegistryPath(${JSON.stringify(file)});
const keys = Array.from({length:30}, (_, i) => ${JSON.stringify(prefix)} + i);
await Promise.all(keys.map(key => addSpace(key)));
await Promise.all(keys.filter((_, i) => i % 2 === 0).map(key => removeSpace(key)));
const slots = await tryReserveWatchlistSlots('shared', keys.map(key => 'watch-' + key), 3, {pid:${process.pid}});
console.log(JSON.stringify(slots));
`,
				],
				{timeout: 15_000},
			);
		const results = await Promise.all([worker('A-'), worker('B-')]);
		const keys = getRegisteredSpaces();
		t.is(keys.length, 30);
		for (const prefix of ['A-', 'B-']) {
			for (let i = 0; i < 30; i++)
				t.is(keys.includes(`${prefix}${i}`), i % 2 !== 0);
		}
		const reserved = results.flatMap(
			result => (JSON.parse(result.stdout) as {reserved: string[]}).reserved,
		);
		t.is(reserved.length, 3);
		t.is(
			Object.keys(
				JSON.parse(
					fs.readFileSync(path.join(dir, 'watchlist-spawns.json'), 'utf8'),
				),
			).length,
			3,
		);
		t.false(fs.existsSync(`${file}.lock`));
	},
);

test.serial(
	'dead owners and abandoned empty locks are reclaimed without stealing old live locks',
	async t => {
		const {file} = fixture(t);
		const lock = `${file}.lock`;
		await exec(process.execPath, [
			'-e',
			`const fs = require('node:fs'); fs.mkdirSync(${JSON.stringify(lock)}); fs.writeFileSync(${JSON.stringify(lock)} + '/' + process.pid + '-abcdef', '');`,
		]);
		await addSpace('recovered');
		t.deepEqual(getRegisteredSpaces(), ['recovered']);
		fs.mkdirSync(lock);
		fs.utimesSync(lock, new Date(0), new Date(0));
		await addSpace('empty');
		fs.mkdirSync(lock);
		const owner = path.join(lock, `${process.pid}-abcdef`);
		fs.writeFileSync(owner, '');
		fs.utimesSync(lock, new Date(0), new Date(0));
		setLockTimingForTests({timeoutMs: 30, retryMs: 2, staleMs: 1});
		await t.throwsAsync(removeSpace('recovered'), {message: /timed out/});
		t.true(fs.existsSync(owner));
		t.deepEqual(getRegisteredSpaces(), ['recovered', 'empty']);
	},
);

test.serial(
	'aborted lock wait performs no mutation and subsequent queued work can retry',
	async t => {
		const {file} = fixture(t);
		const lock = `${file}.lock`;
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, `${process.pid}-abcdef`), '');
		const abort = new AbortController();
		const pending = addSpace('canceled', abort.signal);
		setTimeout(() => abort.abort(), 10);
		await t.throwsAsync(pending, {name: 'AbortError'});
		t.false(fs.existsSync(file));
		fs.rmSync(lock, {recursive: true});
		await Promise.all([addSpace('A'), addSpace('B'), removeSpace('A')]);
		t.deepEqual(getRegisteredSpaces(), ['B']);
	},
);

test.serial(
	'canceled startup and failed setup release reservations; registered workspaces keep capacity',
	async t => {
		fixture(t);
		await tryReserveWatchlistSlots(
			'watch',
			['canceled', 'failed', 'started'],
			3,
		);
		const queue = new StartupQueue();
		const pending = queue
			.enqueue(async () => {
				t.fail('canceled setup ran');
			})
			.finally(async () => releaseWatchlistReservation('canceled'));
		queue.stop();
		await pending;
		await Promise.reject(new Error('setup failed')).catch(async () =>
			releaseWatchlistReservation('failed'),
		);
		await addSpace('started');
		await releaseWatchlistReservation('started');
		const slots = await tryReserveWatchlistSlots(
			'watch',
			['next-1', 'next-2', 'next-3'],
			3,
		);
		t.is(slots.occupied, 1);
		t.deepEqual(slots.reserved, ['next-1', 'next-2']);
	},
);

test.serial(
	'write failures propagate and release the lock; malformed state is never overwritten',
	async t => {
		const {file} = fixture(t);
		fs.mkdirSync(file);
		await t.throwsAsync(addSpace('A'));
		t.false(fs.existsSync(`${file}.lock`));
		fs.rmdirSync(file);
		fs.writeFileSync(file, '{');
		await t.throwsAsync(addSpace('A'));
		t.is(fs.readFileSync(file, 'utf8'), '{');
		t.false(fs.existsSync(`${file}.lock`));
	},
);
