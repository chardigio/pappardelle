import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';
import {resetLockTimingForTests, setLockTimingForTests} from './file-lock.ts';
import {getRegistryPathForRepo, listOpenSpaces} from './space-registry.ts';
import {createStateDaos} from './state-daos.ts';

const readFile = (file: string) =>
	JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;

/** Everything beside the registry file: temp files, lock directories, sidecars. */
const siblings = (registryFile: string) =>
	fs
		.readdirSync(path.dirname(registryFile))
		.filter(name => name !== path.basename(registryFile))
		.sort();

// ============================================================================
// What every registry does, whichever way it is stored
// ============================================================================

contractTest('a repo that has never opened a space has no registry', s => {
	expect(s.daos.registry.openSpaces()).toBe(null);
	expect(listOpenSpaces(s.daos.registry)).toStrictEqual([]);
	expect(s.daos.registry.has('STA-1')).toBe(false);
});

contractTest('add opens a space and writes the registry file', async s => {
	await s.daos.registry.add('STA-100');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-100']);
	expect(await s.daos.registry.openSpacesAsync()).toStrictEqual(['STA-100']);
	expect(readFile(s.registryFile)).toStrictEqual(['STA-100']);
	expect(s.daos.registry.has('STA-100')).toBe(true);
	expect(s.daos.registry.has('STA-999')).toBe(false);
});

contractTest('an open space is in the open phase', async s => {
	expect(s.daos.registry.phase('STA-100')).toStrictEqual({kind: 'unknown'});
	await s.daos.registry.add('STA-100');
	expect(s.daos.registry.phase('STA-100')).toStrictEqual({
		kind: 'phase',
		phase: 'open',
	});
	expect(s.daos.registry.phase('STA-200')).toStrictEqual({kind: 'unknown'});
});

contractTest(
	'a registry that cannot be read never makes a space unknown',
	s => {
		fs.writeFileSync(s.registryFile, 'not json{');
		expect(s.daos.registry.phase('STA-100').kind).toBe('unreadable');
	},
);

test('sqlite: a space being set up or torn down is in that phase', async () => {
	const {registry} = testState({sqlite: true}).daos;
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

contractTest('adding a space twice lists it once', async s => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.add('STA-100');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-100']);
});

contractTest('remove closes a space in the file too', async s => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.add('STA-200');
	await s.daos.registry.remove('STA-100');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-200']);
	expect(readFile(s.registryFile)).toStrictEqual(['STA-200']);
});

contractTest('removing a space that is not open changes nothing', async s => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.remove('STA-999');
	expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-100']);
});

contractTest(
	'the last space closing leaves an empty registry, not a missing one',
	async s => {
		await s.daos.registry.add('STA-100');
		await s.daos.registry.remove('STA-100');
		expect(s.daos.registry.openSpaces()).toStrictEqual([]);
		expect(readFile(s.registryFile)).toStrictEqual([]);
	},
);

contractTest(
	'a registry file from another process is read, without duplicates or non-keys',
	s => {
		fs.writeFileSync(
			s.registryFile,
			JSON.stringify(['STA-1', 42, null, 'STA-1', 'STA-2']),
		);
		expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-1', 'STA-2']);
	},
);

// STA-1553: the registry is shared by every Pappardelle running against the
// repo. A process must see what another wrote since its last read, and apply
// only its own change on top, or it drops a space whose sessions are alive
// and the next startup reaps them.
contractTest(
	'a read sees what another process wrote to the file since',
	async s => {
		await s.daos.registry.add('STA-100');
		fs.writeFileSync(s.registryFile, JSON.stringify(['STA-100', 'STA-200']));
		expect(s.daos.registry.openSpaces()).toStrictEqual(['STA-100', 'STA-200']);
	},
);

contractTest('add keeps a space another process added to the file', async s => {
	await s.daos.registry.add('STA-100');
	fs.writeFileSync(s.registryFile, JSON.stringify(['STA-100', 'STA-200']));
	await s.daos.registry.add('STA-300');
	expect(readFile(s.registryFile)).toStrictEqual([
		'STA-100',
		'STA-200',
		'STA-300',
	]);
});

contractTest(
	'remove keeps a space another process added to the file',
	async s => {
		await s.daos.registry.add('STA-100');
		await s.daos.registry.add('STA-200');
		fs.writeFileSync(
			s.registryFile,
			JSON.stringify(['STA-100', 'STA-200', 'STA-300']),
		);
		await s.daos.registry.remove('STA-100');
		expect(readFile(s.registryFile)).toStrictEqual(['STA-200', 'STA-300']);
	},
);

contractTest(
	'removing a space another process already removed leaves the rest',
	async s => {
		await s.daos.registry.add('STA-100');
		await s.daos.registry.add('STA-200');
		fs.writeFileSync(s.registryFile, JSON.stringify(['STA-200']));
		await s.daos.registry.remove('STA-100');
		expect(readFile(s.registryFile)).toStrictEqual(['STA-200']);
	},
);

contractTest(
	'a registry file that cannot be read is never overwritten',
	async s => {
		for (const broken of ['{', '{}']) {
			fs.writeFileSync(s.registryFile, broken);
			// eslint-disable-next-line no-await-in-loop -- One broken file at a time.
			await rejectionOf(s.daos.registry.add('STA-1'));
			expect(fs.readFileSync(s.registryFile, 'utf8')).toBe(broken);
		}

		expect(siblings(s.registryFile)).toStrictEqual([]);
	},
);

contractTest('writes leave nothing beside the registry file', async s => {
	await s.daos.registry.add('STA-1');
	await s.daos.registry.add('STA-2');
	await s.daos.registry.remove('STA-1');
	expect(siblings(s.registryFile)).toStrictEqual([]);
});

contractTest('an aborted write changes nothing', async s => {
	const lock = `${s.registryFile}.lock`;
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, `${process.pid}-abcdef`), '');
	const abort = new AbortController();
	const pending = s.daos.registry.add('canceled', abort.signal);
	setTimeout(() => {
		abort.abort();
	}, 10);
	await rejectionOf(pending).then(error => {
		expect(error).toHaveProperty('name', 'AbortError');
	});
	expect(fs.existsSync(s.registryFile)).toBe(false);
	fs.rmSync(lock, {recursive: true});
	await Promise.all([
		s.daos.registry.add('A'),
		s.daos.registry.add('B'),
		s.daos.registry.remove('A'),
	]);
	expect(s.daos.registry.openSpaces()).toStrictEqual(['B']);
});

for (const sqlite of [false, true]) {
	const name = sqlite ? 'sqlite' : 'json';

	test(`${name}: each repo has a registry of its own`, async () => {
		const {stateDir} = testState({sqlite});
		const repoA = createStateDaos({repo: 'repo-a', stateDir, sqlite}).registry;
		const repoB = createStateDaos({repo: 'repo-b', stateDir, sqlite}).registry;
		await repoA.add('A-1');
		await repoA.add('A-2');
		await repoB.add('B-1');
		expect(repoB.openSpaces()).toStrictEqual(['B-1']);
		expect(repoA.openSpaces()).toStrictEqual(['A-1', 'A-2']);
		expect(readFile(getRegistryPathForRepo('repo-a', stateDir))).toStrictEqual([
			'A-1',
			'A-2',
		]);
	});

	// Before state was kept per repo there was one registry for all of them.
	test(`${name}: the pre-repo registry moves to the first repo that starts`, () => {
		const {stateDir} = testState({sqlite});
		const legacy = path.join(stateDir, 'open-spaces.json');
		fs.writeFileSync(legacy, JSON.stringify(['STA-100', 'STA-200']));
		const {registry} = createStateDaos({
			repo: 'stardust-labs',
			stateDir,
			sqlite,
		});
		expect(registry.openSpaces()).toStrictEqual(['STA-100', 'STA-200']);
		expect(fs.existsSync(legacy)).toBe(false);
	});

	test(`${name}: a repo that already has a registry keeps it, and the pre-repo one is dropped`, () => {
		const {stateDir} = testState({sqlite});
		const legacy = path.join(stateDir, 'open-spaces.json');
		fs.writeFileSync(legacy, JSON.stringify(['OLD-1', 'OLD-2']));
		const current = getRegistryPathForRepo('stardust-labs', stateDir);
		fs.mkdirSync(path.dirname(current), {recursive: true});
		fs.writeFileSync(current, JSON.stringify(['NEW-1']));
		const {registry} = createStateDaos({
			repo: 'stardust-labs',
			stateDir,
			sqlite,
		});
		expect(registry.openSpaces()).toStrictEqual(['NEW-1']);
		expect(fs.existsSync(legacy)).toBe(false);
	});
}

test('the two stores leave the same registry file for the same history', async () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const s = testState({sqlite});
		/* eslint-disable no-await-in-loop -- The history is a sequence. */
		await s.daos.registry.add('STA-1');
		await s.daos.registry.add('STA-2');
		await s.daos.registry.add('STA-3');
		await s.daos.registry.remove('STA-2');
		await s.daos.registry.add('STA-1');
		/* eslint-enable no-await-in-loop */
		files.push(fs.readFileSync(s.registryFile, 'utf8'));
	}

	expect(files[0]).toBe(files[1]);
	expect(files[0]).toBe('[\n  "STA-1",\n  "STA-3"\n]\n');
});

// ============================================================================
// The registry file and its lock, as a process without the database uses them
// ============================================================================

test('json: a registry file that cannot be read throws, and never reads as empty', async () => {
	const s = testState({sqlite: false});
	for (const broken of ['{', '{}']) {
		fs.writeFileSync(s.registryFile, broken);
		expect(() => s.daos.registry.openSpaces()).toThrow();
		// eslint-disable-next-line no-await-in-loop -- One broken file at a time.
		await rejectionOf(s.daos.registry.openSpacesAsync());
		expect(listOpenSpaces(s.daos.registry)).toStrictEqual([]);
	}
});

test('getRegistryPathForRepo keeps each repo under ~/.pappardelle/repos/', () => {
	const first = getRegistryPathForRepo('stardust-labs');
	expect(
		first.endsWith('/.pappardelle/repos/stardust-labs/open-spaces.json'),
	).toBe(true);
	expect(first).not.toBe(getRegistryPathForRepo('pappa-chex'));
});

test('json: a held lock times out without writing and leaves timers responsive', async () => {
	const s = testState({sqlite: false});
	const lock = `${s.registryFile}.lock`;
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, `${process.pid}-aaaaaaaa`), '');
	setLockTimingForTests({timeoutMs: 300, retryMs: 5, staleMs: 1});
	teardown(resetLockTimingForTests);
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 2);
	try {
		expect(await rejectionOf(s.daos.registry.add('STA-1'))).toHaveProperty(
			'message',
			expect.stringMatching(/timed out/),
		);
		expect(ticks > 5).toBe(true);
		expect(fs.existsSync(s.registryFile)).toBe(false);
		expect(fs.existsSync(lock)).toBe(true);
	} finally {
		clearInterval(timer);
	}
});

// ============================================================================
// Watchlist slot reservations (STE-25)
// ============================================================================

const ME = 1000;
const OTHER = 2000;
const DEAD = 3000;
const isPidAlive = (pid: number) => pid !== DEAD;
const sidecar = (registryFile: string) =>
	readFile(path.join(path.dirname(registryFile), 'watchlist-spawns.json'));

contractTest(
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
		expect(sidecar(s.registryFile)).toStrictEqual({
			'STE-1': {source: 'top-level', ownerPid: ME},
			'STE-2': {source: 'top-level', ownerPid: ME},
		});
	},
);

contractTest(
	'a second instance only gets the slots the first left',
	async s => {
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
	},
);

contractTest(
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

contractTest(
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
		expect(Object.keys(sidecar(s.registryFile) as object)).toStrictEqual([
			'STE-2',
		]);
	},
);

contractTest(
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

contractTest(
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

contractTest('each watchlist counts its own slots', async s => {
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

contractTest(
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
		expect(Object.keys(sidecar(s.registryFile) as object)).toStrictEqual([
			'STE-2',
		]);
	},
);

contractTest('closing a space frees its watchlist slot', async s => {
	await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
		pid: ME,
		isPidAlive,
	});
	await s.daos.registry.add('STE-1');
	await s.daos.registry.remove('STE-1');
	expect(sidecar(s.registryFile)).toStrictEqual({});
	expect(
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-2'], 1, {
			pid: ME,
			isPidAlive,
		}),
	).toStrictEqual({reserved: ['STE-2'], occupied: 0, claimedElsewhere: []});
});

// Without this an instance would respawn the key as soon as the instance
// that holds it closed the workspace.
contractTest(
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
