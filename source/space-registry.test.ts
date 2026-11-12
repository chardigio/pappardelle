import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
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

contractTest('a repo that has never opened a space has no registry', (t, s) => {
	t.is(s.daos.registry.openSpaces(), null);
	t.deepEqual(listOpenSpaces(s.daos.registry), []);
	t.false(s.daos.registry.has('STA-1'));
});

contractTest('add opens a space and writes the registry file', async (t, s) => {
	await s.daos.registry.add('STA-100');
	t.deepEqual(s.daos.registry.openSpaces(), ['STA-100']);
	t.deepEqual(await s.daos.registry.openSpacesAsync(), ['STA-100']);
	t.deepEqual(readFile(s.registryFile), ['STA-100']);
	t.true(s.daos.registry.has('STA-100'));
	t.false(s.daos.registry.has('STA-999'));
});

contractTest('adding a space twice lists it once', async (t, s) => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.add('STA-100');
	t.deepEqual(s.daos.registry.openSpaces(), ['STA-100']);
});

contractTest('remove closes a space in the file too', async (t, s) => {
	await s.daos.registry.add('STA-100');
	await s.daos.registry.add('STA-200');
	await s.daos.registry.remove('STA-100');
	t.deepEqual(s.daos.registry.openSpaces(), ['STA-200']);
	t.deepEqual(readFile(s.registryFile), ['STA-200']);
});

contractTest(
	'removing a space that is not open changes nothing',
	async (t, s) => {
		await s.daos.registry.add('STA-100');
		await s.daos.registry.remove('STA-999');
		t.deepEqual(s.daos.registry.openSpaces(), ['STA-100']);
	},
);

contractTest(
	'the last space closing leaves an empty registry, not a missing one',
	async (t, s) => {
		await s.daos.registry.add('STA-100');
		await s.daos.registry.remove('STA-100');
		t.deepEqual(s.daos.registry.openSpaces(), []);
		t.deepEqual(readFile(s.registryFile), []);
	},
);

contractTest(
	'a registry file from another process is read, without duplicates or non-keys',
	(t, s) => {
		fs.writeFileSync(
			s.registryFile,
			JSON.stringify(['STA-1', 42, null, 'STA-1', 'STA-2']),
		);
		t.deepEqual(s.daos.registry.openSpaces(), ['STA-1', 'STA-2']);
	},
);

// STA-1553: the registry is shared by every Pappardelle running against the
// repo. A process must see what another wrote since its last read, and apply
// only its own change on top, or it drops a space whose sessions are alive
// and the next startup reaps them.
contractTest(
	'a read sees what another process wrote to the file since',
	async (t, s) => {
		await s.daos.registry.add('STA-100');
		fs.writeFileSync(s.registryFile, JSON.stringify(['STA-100', 'STA-200']));
		t.deepEqual(s.daos.registry.openSpaces(), ['STA-100', 'STA-200']);
	},
);

contractTest(
	'add keeps a space another process added to the file',
	async (t, s) => {
		await s.daos.registry.add('STA-100');
		fs.writeFileSync(s.registryFile, JSON.stringify(['STA-100', 'STA-200']));
		await s.daos.registry.add('STA-300');
		t.deepEqual(readFile(s.registryFile), ['STA-100', 'STA-200', 'STA-300']);
	},
);

contractTest(
	'remove keeps a space another process added to the file',
	async (t, s) => {
		await s.daos.registry.add('STA-100');
		await s.daos.registry.add('STA-200');
		fs.writeFileSync(
			s.registryFile,
			JSON.stringify(['STA-100', 'STA-200', 'STA-300']),
		);
		await s.daos.registry.remove('STA-100');
		t.deepEqual(readFile(s.registryFile), ['STA-200', 'STA-300']);
	},
);

contractTest(
	'removing a space another process already removed leaves the rest',
	async (t, s) => {
		await s.daos.registry.add('STA-100');
		await s.daos.registry.add('STA-200');
		fs.writeFileSync(s.registryFile, JSON.stringify(['STA-200']));
		await s.daos.registry.remove('STA-100');
		t.deepEqual(readFile(s.registryFile), ['STA-200']);
	},
);

contractTest(
	'a registry file that cannot be read is never overwritten',
	async (t, s) => {
		for (const broken of ['{', '{}']) {
			fs.writeFileSync(s.registryFile, broken);
			// eslint-disable-next-line no-await-in-loop -- One broken file at a time.
			await t.throwsAsync(s.daos.registry.add('STA-1'));
			t.is(fs.readFileSync(s.registryFile, 'utf8'), broken);
		}

		t.deepEqual(siblings(s.registryFile), []);
	},
);

contractTest('writes leave nothing beside the registry file', async (t, s) => {
	await s.daos.registry.add('STA-1');
	await s.daos.registry.add('STA-2');
	await s.daos.registry.remove('STA-1');
	t.deepEqual(siblings(s.registryFile), []);
});

contractTest('an aborted write changes nothing', async (t, s) => {
	const lock = `${s.registryFile}.lock`;
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, `${process.pid}-abcdef`), '');
	const abort = new AbortController();
	const pending = s.daos.registry.add('canceled', abort.signal);
	setTimeout(() => {
		abort.abort();
	}, 10);
	await t.throwsAsync(pending, {name: 'AbortError'});
	t.false(fs.existsSync(s.registryFile));
	fs.rmSync(lock, {recursive: true});
	await Promise.all([
		s.daos.registry.add('A'),
		s.daos.registry.add('B'),
		s.daos.registry.remove('A'),
	]);
	t.deepEqual(s.daos.registry.openSpaces(), ['B']);
});

for (const sqlite of [false, true]) {
	const name = sqlite ? 'sqlite' : 'json';

	test(`${name}: each repo has a registry of its own`, async t => {
		const {stateDir} = testState(t, {sqlite});
		const repoA = createStateDaos({repo: 'repo-a', stateDir, sqlite}).registry;
		const repoB = createStateDaos({repo: 'repo-b', stateDir, sqlite}).registry;
		await repoA.add('A-1');
		await repoA.add('A-2');
		await repoB.add('B-1');
		t.deepEqual(repoB.openSpaces(), ['B-1']);
		t.deepEqual(repoA.openSpaces(), ['A-1', 'A-2']);
		t.deepEqual(readFile(getRegistryPathForRepo('repo-a', stateDir)), [
			'A-1',
			'A-2',
		]);
	});

	// Before state was kept per repo there was one registry for all of them.
	test(`${name}: the pre-repo registry moves to the first repo that starts`, t => {
		const {stateDir} = testState(t, {sqlite});
		const legacy = path.join(stateDir, 'open-spaces.json');
		fs.writeFileSync(legacy, JSON.stringify(['STA-100', 'STA-200']));
		const {registry} = createStateDaos({
			repo: 'stardust-labs',
			stateDir,
			sqlite,
		});
		t.deepEqual(registry.openSpaces(), ['STA-100', 'STA-200']);
		t.false(fs.existsSync(legacy));
	});

	test(`${name}: a repo that already has a registry keeps it, and the pre-repo one is dropped`, t => {
		const {stateDir} = testState(t, {sqlite});
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
		t.deepEqual(registry.openSpaces(), ['NEW-1']);
		t.false(fs.existsSync(legacy));
	});
}

test('the two stores leave the same registry file for the same history', async t => {
	const files = [];
	for (const sqlite of [false, true]) {
		const s = testState(t, {sqlite});
		/* eslint-disable no-await-in-loop -- The history is a sequence. */
		await s.daos.registry.add('STA-1');
		await s.daos.registry.add('STA-2');
		await s.daos.registry.add('STA-3');
		await s.daos.registry.remove('STA-2');
		await s.daos.registry.add('STA-1');
		/* eslint-enable no-await-in-loop */
		files.push(fs.readFileSync(s.registryFile, 'utf8'));
	}

	t.is(files[0], files[1]);
	t.is(files[0], '[\n  "STA-1",\n  "STA-3"\n]\n');
});

// ============================================================================
// The registry file and its lock, as a process without the database uses them
// ============================================================================

test('json: a registry file that cannot be read throws, and never reads as empty', async t => {
	const s = testState(t, {sqlite: false});
	for (const broken of ['{', '{}']) {
		fs.writeFileSync(s.registryFile, broken);
		t.throws(() => s.daos.registry.openSpaces());
		// eslint-disable-next-line no-await-in-loop -- One broken file at a time.
		await t.throwsAsync(s.daos.registry.openSpacesAsync());
		t.deepEqual(listOpenSpaces(s.daos.registry), []);
	}
});

test('getRegistryPathForRepo keeps each repo under ~/.pappardelle/repos/', t => {
	const first = getRegistryPathForRepo('stardust-labs');
	t.true(first.endsWith('/.pappardelle/repos/stardust-labs/open-spaces.json'));
	t.not(first, getRegistryPathForRepo('pappa-chex'));
});

test.serial(
	'json: a held lock times out without writing and leaves timers responsive',
	async t => {
		const s = testState(t, {sqlite: false});
		const lock = `${s.registryFile}.lock`;
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, `${process.pid}-aaaaaaaa`), '');
		setLockTimingForTests({timeoutMs: 60, retryMs: 5, staleMs: 1});
		t.teardown(resetLockTimingForTests);
		let ticks = 0;
		const timer = setInterval(() => {
			ticks++;
		}, 2);
		try {
			await t.throwsAsync(s.daos.registry.add('STA-1'), {message: /timed out/});
			t.true(ticks > 5);
			t.false(fs.existsSync(s.registryFile));
			t.true(fs.existsSync(lock));
		} finally {
			clearInterval(timer);
		}
	},
);

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
	async (t, s) => {
		t.deepEqual(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-1', 'STE-2', 'STE-3'],
				2,
				{pid: ME, isPidAlive},
			),
			{reserved: ['STE-1', 'STE-2'], occupied: 0, claimedElsewhere: []},
		);
		t.deepEqual(sidecar(s.registryFile), {
			'STE-1': {source: 'top-level', ownerPid: ME},
			'STE-2': {source: 'top-level', ownerPid: ME},
		});
	},
);

contractTest(
	'a second instance only gets the slots the first left',
	async (t, s) => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 2, {
			pid: ME,
			isPidAlive,
		});
		t.deepEqual(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-5', 'STE-6', 'STE-7'],
				2,
				{pid: OTHER, isPidAlive},
			),
			{reserved: ['STE-5'], occupied: 1, claimedElsewhere: []},
		);
	},
);

contractTest(
	'a reservation still holds its slot once its space is open',
	async (t, s) => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: ME,
			isPidAlive,
		});
		await s.daos.registry.add('STE-1');
		t.deepEqual(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-2'],
				1,
				{
					pid: ME,
					isPidAlive,
				},
			),
			{reserved: [], occupied: 1, claimedElsewhere: []},
		);
	},
);

contractTest(
	'a dead owner frees a reservation whose space never opened',
	async (t, s) => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: DEAD,
			isPidAlive,
		});
		t.deepEqual(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-2'],
				1,
				{
					pid: ME,
					isPidAlive,
				},
			),
			{reserved: ['STE-2'], occupied: 0, claimedElsewhere: []},
		);
		t.deepEqual(Object.keys(sidecar(s.registryFile) as object), ['STE-2']);
	},
);

contractTest(
	'an open space still counts after the process that reserved it dies',
	async (t, s) => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: DEAD,
			isPidAlive,
		});
		await s.daos.registry.add('STE-1');
		t.deepEqual(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-2'],
				1,
				{
					pid: ME,
					isPidAlive,
				},
			),
			{reserved: [], occupied: 1, claimedElsewhere: []},
		);
	},
);

contractTest(
	'keys that are open or reserved elsewhere are reported as claimed',
	async (t, s) => {
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
		t.deepEqual(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-1', 'STE-2', 'STE-3'],
				5,
				{pid: ME, isPidAlive},
			),
			{reserved: ['STE-3'], occupied: 0, claimedElsewhere: ['STE-1', 'STE-2']},
		);
	},
);

contractTest('each watchlist counts its own slots', async (t, s) => {
	await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
		pid: ME,
		isPidAlive,
	});
	t.deepEqual(
		await s.daos.registry.tryReserveWatchlistSlots(
			'profile:chaz',
			['CHAZ-1'],
			1,
			{
				pid: ME,
				isPidAlive,
			},
		),
		{reserved: ['CHAZ-1'], occupied: 0, claimedElsewhere: []},
	);
});

contractTest(
	'releasing drops a reservation whose space never opened, and keeps one that did',
	async (t, s) => {
		await s.daos.registry.tryReserveWatchlistSlots(
			'top-level',
			['STE-1', 'STE-2'],
			2,
			{pid: ME, isPidAlive},
		);
		await s.daos.registry.add('STE-2');
		await s.daos.registry.releaseWatchlistReservation('STE-1');
		await s.daos.registry.releaseWatchlistReservation('STE-2');
		t.deepEqual(Object.keys(sidecar(s.registryFile) as object), ['STE-2']);
	},
);

contractTest('closing a space frees its watchlist slot', async (t, s) => {
	await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
		pid: ME,
		isPidAlive,
	});
	await s.daos.registry.add('STE-1');
	await s.daos.registry.remove('STE-1');
	t.deepEqual(sidecar(s.registryFile), {});
	t.deepEqual(
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-2'], 1, {
			pid: ME,
			isPidAlive,
		}),
		{reserved: ['STE-2'], occupied: 0, claimedElsewhere: []},
	);
});

// Without this an instance would respawn the key as soon as the instance
// that holds it closed the workspace.
contractTest(
	'a key another instance holds is claimed even when the cap is reached',
	async (t, s) => {
		await s.daos.registry.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
			pid: OTHER,
			isPidAlive,
		});
		t.deepEqual(
			await s.daos.registry.tryReserveWatchlistSlots(
				'top-level',
				['STE-1', 'STE-2'],
				1,
				{pid: ME, isPidAlive},
			),
			{reserved: [], occupied: 1, claimedElsewhere: ['STE-1']},
		);
	},
);
