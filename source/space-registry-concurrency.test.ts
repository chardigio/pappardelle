import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';
import {resetLockTimingForTests, setLockTimingForTests} from './file-lock.ts';
import {StartupQueue} from './startup-queue.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

// The registry is shared by every Pappardelle running against a repo, and
// each of them opens and closes spaces by itself.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: two processes add, remove and reserve without losing updates or exceeding capacity`, async () => {
		const {daos, stateDir, registryFile} = testState({sqlite});
		const worker = async (prefix: string) =>
			exec(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {registry} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(stateDir)}, sqlite: ${sqlite}});
const keys = Array.from({length:30}, (_, i) => ${JSON.stringify(prefix)} + i);
await Promise.all(keys.map(key => registry.add(key)));
await Promise.all(keys.filter((_, i) => i % 2 === 0).map(key => registry.remove(key)));
const slots = await registry.tryReserveWatchlistSlots('shared', keys.map(key => 'watch-' + key), 3, {pid:${process.pid}});
console.log(JSON.stringify(slots));
`,
				],
				{timeout: 30_000},
			);
		const results = await Promise.all([worker('A-'), worker('B-')]);
		const keys = daos.registry.openSpaces() ?? [];
		expect(keys.length).toBe(30);
		for (const prefix of ['A-', 'B-']) {
			for (let i = 0; i < 30; i++)
				expect(keys.includes(`${prefix}${i}`)).toBe(i % 2 !== 0);
		}

		expect(
			[
				...(JSON.parse(fs.readFileSync(registryFile, 'utf8')) as string[]),
			].sort(),
		).toStrictEqual([...keys].sort());
		const reserved = results.flatMap(
			result => (JSON.parse(result.stdout) as {reserved: string[]}).reserved,
		);
		expect(reserved.length).toBe(3);
		expect(
			Object.keys(
				JSON.parse(
					fs.readFileSync(
						path.join(path.dirname(registryFile), 'watchlist-spawns.json'),
						'utf8',
					),
				) as object,
			).length,
		).toBe(3);
		expect(fs.existsSync(`${registryFile}.lock`)).toBe(false);
	});
}

contractTest(
	'canceled startup and failed setup release reservations; open spaces keep capacity',
	async ({daos: {registry}}) => {
		await registry.tryReserveWatchlistSlots(
			'watch',
			['canceled', 'failed', 'started'],
			3,
		);
		const queue = new StartupQueue();
		const pending = queue
			.enqueue(async () => {
				unreachable('canceled setup ran');
			})
			.finally(async () => registry.releaseWatchlistReservation('canceled'));
		queue.stop();
		await pending;
		await Promise.reject(new Error('setup failed')).catch(async () =>
			registry.releaseWatchlistReservation('failed'),
		);
		await registry.add('started');
		await registry.releaseWatchlistReservation('started');
		const slots = await registry.tryReserveWatchlistSlots(
			'watch',
			['next-1', 'next-2', 'next-3'],
			3,
		);
		expect(slots.occupied).toBe(1);
		expect(slots.reserved).toStrictEqual(['next-1', 'next-2']);
	},
);

// The advisory lock both stores take around the registry file.
test('json: dead owners and abandoned empty locks are reclaimed without stealing old live locks', async () => {
	const {daos, registryFile} = testState({sqlite: false});
	teardown(resetLockTimingForTests);
	const lock = `${registryFile}.lock`;
	await exec(process.execPath, [
		'-e',
		`const fs = require('node:fs'); fs.mkdirSync(${JSON.stringify(lock)}); fs.writeFileSync(${JSON.stringify(lock)} + '/' + process.pid + '-abcdef', '');`,
	]);
	await daos.registry.add('recovered');
	expect(daos.registry.openSpaces()).toStrictEqual(['recovered']);
	fs.mkdirSync(lock);
	fs.utimesSync(lock, new Date(0), new Date(0));
	await daos.registry.add('empty');
	fs.mkdirSync(lock);
	const owner = path.join(lock, `${process.pid}-abcdef`);
	fs.writeFileSync(owner, '');
	fs.utimesSync(lock, new Date(0), new Date(0));
	setLockTimingForTests({timeoutMs: 30, retryMs: 2, staleMs: 1});
	expect(await rejectionOf(daos.registry.remove('recovered'))).toHaveProperty(
		'message',
		expect.stringMatching(/timed out/),
	);
	expect(fs.existsSync(owner)).toBe(true);
	expect(daos.registry.openSpaces()).toStrictEqual(['recovered', 'empty']);
});

test('json: a failed write propagates and releases the lock', async () => {
	const {daos, registryFile} = testState({sqlite: false});
	fs.mkdirSync(registryFile);
	await rejectionOf(daos.registry.add('A'));
	expect(fs.existsSync(`${registryFile}.lock`)).toBe(false);
});
