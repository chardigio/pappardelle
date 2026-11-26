import {test, expect} from 'bun:test';
import {storeTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {getRegistryPathForRepo, listOpenSpaces} from './space-registry.ts';
import {createStateDaos} from './state-daos.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

storeTest('a repo that has never opened a space has none open', s => {
	expect(s.daos.registry.openSpaces()).toStrictEqual([]);
	expect(listOpenSpaces(s.daos.registry)).toStrictEqual([]);
	expect(s.daos.registry.has('STA-1')).toBe(false);
});

storeTest('add opens a space', async s => {
	await s.daos.registry.add('STA-100');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-100']);
	expect(s.daos.registry.has('STA-100')).toBe(true);
	expect(s.daos.registry.has('STA-999')).toBe(false);
});

storeTest('an open space is in the open phase', async s => {
	expect(s.daos.registry.phase('STA-100')).toStrictEqual({kind: 'unknown'});
	await s.daos.registry.add('STA-100');
	expect(s.daos.registry.phase('STA-100')).toStrictEqual({
		kind: 'phase',
		phase: 'open',
	});
	expect(s.daos.registry.phase('STA-200')).toStrictEqual({kind: 'unknown'});
});

storeTest('a space being set up or torn down is in that phase', async s => {
	const {registry} = s.daos;
	await registry.reserveStart('STA-1', process.pid);
	await registry.add('STA-2');
	await registry.markClosing('STA-2');
	expect(registry.phase('STA-1')).toStrictEqual({
		kind: 'phase',
		phase: 'starting',
	});
	expect(registry.phase('STA-2')).toStrictEqual({
		kind: 'phase',
		phase: 'closing',
	});
});

storeTest('adding a space twice lists it once', async s => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.add('STA-100');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-100']);
});

storeTest('remove closes a space', async s => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.add('STA-200');
	await s.daos.registry.remove('STA-100');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-200']);
});

storeTest('removing a space that is not open changes nothing', async s => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.remove('STA-999');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-100']);
});

test('each repo has a registry of its own', async () => {
	const {stateDir} = testState();
	const repoA = createStateDaos({repo: 'repo-a', stateDir}).registry;
	const repoB = createStateDaos({repo: 'repo-b', stateDir}).registry;
	await repoA.add('A-1');
	await repoA.add('A-2');
	await repoB.add('B-1');
	expect(repoB.openSpaces()).toStrictEqual(['B-1']);
	expect(repoA.openSpaces()).toStrictEqual(['A-1', 'A-2']);
});

test('getRegistryPathForRepo keeps each repo under ~/.pappardelle/repos/', () => {
	const first = getRegistryPathForRepo('stardust-labs');
	expect(
		first.endsWith('/.pappardelle/repos/stardust-labs/open-spaces.json'),
	).toBe(true);
	expect(first).not.toBe(getRegistryPathForRepo('pappa-chex'));
});

// ============================================================================
// Watchlist slot reservations (STE-25)
// ============================================================================

const ME = 1000;
const OTHER = 2000;
const DEAD = 3000;
const isPidAlive = (pid: number) => pid !== DEAD;
const reservations = (s: TestState) =>
	Object.fromEntries(
		openStateDb(stateDbPath(s.stateDir))
			.db.query<{key: string; source: string; owner_pid: number}, [string]>(
				`SELECT key, source, owner_pid FROM watchlist_reservations
				WHERE repo = ? ORDER BY rowid`,
			)
			.all(s.repo)
			.map(row => [row.key, {source: row.source, ownerPid: row.owner_pid}]),
	);

storeTest(
	'a watchlist reserves at most its cap, in candidate order',
	async s => {
		expect(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-1', 'STE-2', 'STE-3'],
				2,
				{pid: ME, isPidAlive},
			),
		).toStrictEqual({
			reserved: ['STE-1', 'STE-2'],
			occupied: 0,
			claimedElsewhere: [],
		});
		expect(reservations(s)).toStrictEqual({
			'STE-1': {source: 'top-level', ownerPid: ME},
			'STE-2': {source: 'top-level', ownerPid: ME},
		});
	},
);

storeTest('a second instance only gets the slots the first left', async s => {
	await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 2, {
		pid: ME,
		isPidAlive,
	});
	expect(
		await s.daos.registry.tryReserveWatchlistSlots(
			'top-level',
			['STE-5', 'STE-6', 'STE-7'],
			2,
			{pid: OTHER, isPidAlive},
		),
	).toStrictEqual({reserved: ['STE-5'], occupied: 1, claimedElsewhere: []});
});

storeTest(
	'a reservation still holds its slot once its space is open',
	async s => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: ME,
			isPidAlive,
		});
		await s.daos.registry.add('STE-1');
		expect(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-2'],
				1,
				{
					pid: ME,
					isPidAlive,
				},
			),
		).toStrictEqual({reserved: [], occupied: 1, claimedElsewhere: []});
	},
);

storeTest(
	'a dead owner frees a reservation whose space never opened',
	async s => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: DEAD,
			isPidAlive,
		});
		expect(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-2'],
				1,
				{
					pid: ME,
					isPidAlive,
				},
			),
		).toStrictEqual({reserved: ['STE-2'], occupied: 0, claimedElsewhere: []});
		expect(Object.keys(reservations(s))).toStrictEqual(['STE-2']);
	},
);

storeTest(
	'an open space still counts after the process that reserved it dies',
	async s => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: DEAD,
			isPidAlive,
		});
		await s.daos.registry.add('STE-1');
		expect(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-2'],
				1,
				{
					pid: ME,
					isPidAlive,
				},
			),
		).toStrictEqual({reserved: [], occupied: 1, claimedElsewhere: []});
	},
);

storeTest(
	'keys that are open or reserved elsewhere are reported as claimed',
	async s => {
		await s.daos.registry.add('STE-1');
		await s.daos.registry.tryReserveWatchlistSlots(
			'profile:chaz',
			['STE-2'],
			5,
			{
				pid: OTHER,
				isPidAlive,
			},
		);
		expect(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-1', 'STE-2', 'STE-3'],
				5,
				{pid: ME, isPidAlive},
			),
		).toStrictEqual({
			reserved: ['STE-3'],
			occupied: 0,
			claimedElsewhere: ['STE-1', 'STE-2'],
		});
	},
);

storeTest('each watchlist counts its own slots', async s => {
	await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
		pid: ME,
		isPidAlive,
	});
	expect(
		await s.daos.registry.tryReserveWatchlistSlots(
			'profile:chaz',
			['CHAZ-1'],
			1,
			{
				pid: ME,
				isPidAlive,
			},
		),
	).toStrictEqual({reserved: ['CHAZ-1'], occupied: 0, claimedElsewhere: []});
});

storeTest(
	'releasing drops a reservation whose space never opened, and keeps one that did',
	async s => {
		await s.daos.registry.tryReserveWatchlistSlots(
			'top-level',
			['STE-1', 'STE-2'],
			2,
			{pid: ME, isPidAlive},
		);
		await s.daos.registry.add('STE-2');
		await s.daos.registry.releaseWatchlistReservation('STE-1');
		await s.daos.registry.releaseWatchlistReservation('STE-2');
		expect(Object.keys(reservations(s))).toStrictEqual(['STE-2']);
	},
);

storeTest('closing a space frees its watchlist slot', async s => {
	await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
		pid: ME,
		isPidAlive,
	});
	await s.daos.registry.add('STE-1');
	await s.daos.registry.remove('STE-1');
	expect(reservations(s)).toStrictEqual({});
	expect(
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-2'], 1, {
			pid: ME,
			isPidAlive,
		}),
	).toStrictEqual({reserved: ['STE-2'], occupied: 0, claimedElsewhere: []});
});

// Without this an instance would respawn the key as soon as the instance
// that holds it closed the workspace.
storeTest(
	'a key another instance holds is claimed even when the cap is reached',
	async s => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: OTHER,
			isPidAlive,
		});
		expect(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-1', 'STE-2'],
				1,
				{pid: ME, isPidAlive},
			),
		).toStrictEqual({reserved: [], occupied: 1, claimedElsewhere: ['STE-1']});
	},
);
