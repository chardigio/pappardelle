import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
import {storeTest} from '../test/helpers/store-test.ts';
import {testState} from '../test/helpers/state.ts';
import {StartupQueue} from './startup-queue.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

// The registry is shared by every Pappardelle running against a repo, and
// each of them opens and closes spaces by itself.
test('two processes add, remove and reserve without losing updates or exceeding capacity', async () => {
	const {daos, stateDir} = testState();
	const worker = async (prefix: string) =>
		exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {registry} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(stateDir)}});
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
	const keys = daos.registry.openSpaces();
	expect(keys.length).toBe(30);
	for (const prefix of ['A-', 'B-']) {
		for (let i = 0; i < 30; i++)
			expect(keys.includes(`${prefix}${i}`)).toBe(i % 2 !== 0);
	}

	const reserved = results.flatMap(
		result => (JSON.parse(result.stdout) as {reserved: string[]}).reserved,
	);
	expect(reserved.length).toBe(3);
	expect(
		openStateDb(stateDbPath(stateDir))
			.db.query<{key: string}, []>('SELECT key FROM watchlist_reservations')
			.all()
			.map(row => row.key)
			.sort(),
	).toStrictEqual([...reserved].sort());
});

storeTest(
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
