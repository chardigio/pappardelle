import {Database} from 'bun:sqlite';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import test, {type ExecutionContext} from 'ava';
import {testState} from '../test/helpers/state.ts';
import {
	getRegistryPathForRepo,
	JsonSpaceRegistryDao,
	type SettleDeps,
} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import {tearDownSpace} from './space-utils.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const run = promisify(execFile);
const ME = 111;
const ALIVE = 222;
const DEAD = 333;

/** A registry that believes it is process ME, beside one that is ALIVE. */
function fixture(t: ExecutionContext) {
	const {stateDir, registryFile} = testState(t, {sqlite: true});
	const dbPath = stateDbPath(stateDir);
	const registry = (pid: number) =>
		new SqliteSpaceRegistryDao(
			() => openStateDb(dbPath),
			'repo',
			new JsonSpaceRegistryDao(registryFile),
			pid,
			owner => owner !== DEAD,
		);
	const states = () =>
		Object.fromEntries(
			openStateDb(dbPath)
				.db.query<{key: string; state: string}, []>(
					"SELECT key, state FROM spaces WHERE repo = 'repo' ORDER BY rowid",
				)
				.all()
				.map(row => [row.key, row.state]),
		);
	const file = () =>
		JSON.parse(fs.readFileSync(registryFile, 'utf8')) as unknown;
	return {
		stateDir,
		dbPath,
		registryFile,
		mine: registry(ME),
		theirs: registry(ALIVE),
		states,
		file,
	};
}

const settle = (
	live: string[] | null,
	closing: string[] = [],
): SettleDeps & {asked: number} => {
	const deps = {
		asked: 0,
		closing: new Set(closing),
		liveSessionKeys() {
			deps.asked++;
			return live && new Set(live);
		},
	};
	return deps;
};

// ============================================================================
// Starting: recorded before its sessions exist
// ============================================================================

test('a space being set up is not open, but it is there and its sessions are its own', async t => {
	const f = fixture(t);
	await f.mine.add('OPEN-1');
	await f.mine.reserveStart('NEW-1', ALIVE);
	t.deepEqual(f.mine.openSpaces(), ['OPEN-1']);
	t.deepEqual(f.file(), ['OPEN-1']);
	t.true(f.mine.has('NEW-1'));
	t.deepEqual(f.mine.protectedSpaces(), {ok: true, keys: ['OPEN-1', 'NEW-1']});
});

test('opening a space that was being set up lists it', async t => {
	const f = fixture(t);
	await f.mine.reserveStart('NEW-1', ALIVE);
	await f.mine.add('NEW-1');
	t.deepEqual(f.mine.openSpaces(), ['NEW-1']);
	t.deepEqual(f.file(), ['NEW-1']);
});

test('setting up a space that is already open leaves it open', async t => {
	const f = fixture(t);
	await f.mine.add('OPEN-1');
	await f.mine.reserveStart('OPEN-1', ALIVE);
	t.deepEqual(f.states(), {'OPEN-1': 'open'});
});

// ============================================================================
// Closing: recorded before its sessions are killed
// ============================================================================

test('a space being closed leaves the list and the file, and is still there', async t => {
	const f = fixture(t);
	await f.mine.add('A');
	await f.mine.add('B');
	await f.mine.markClosing('A');
	t.deepEqual(f.mine.openSpaces(), ['B']);
	t.deepEqual(f.file(), ['B']);
	t.true(f.mine.has('A'));
	t.deepEqual(f.mine.protectedSpaces(), {ok: true, keys: ['A', 'B']});
	await f.mine.remove('A');
	t.deepEqual(f.states(), {B: 'open'});
});

test('a close whose kill failed puts the space back', async t => {
	const f = fixture(t);
	await f.mine.add('A');
	await f.mine.markClosing('A');
	await f.mine.reopen('A');
	t.deepEqual(f.mine.openSpaces(), ['A']);
	t.deepEqual(f.file(), ['A']);
});

// ============================================================================
// Settling what a process started and did not finish
// ============================================================================

test('a start or close whose owner died follows its sessions: alive is open, gone is removed', async t => {
	const f = fixture(t);
	await f.mine.reserveStart('STARTED', DEAD);
	await f.mine.reserveStart('NEVER-STARTED', DEAD);
	for (const key of ['KILLED', 'NOT-KILLED']) {
		// eslint-disable-next-line no-await-in-loop -- Order is part of the fixture.
		await f.mine.add(key);
	}

	const dead = new SqliteSpaceRegistryDao(
		() => openStateDb(f.dbPath),
		'repo',
		new JsonSpaceRegistryDao(f.registryFile),
		DEAD,
	);
	await dead.markClosing('KILLED');
	await dead.markClosing('NOT-KILLED');

	await f.mine.settle(settle(['STARTED', 'NOT-KILLED']));
	t.deepEqual(f.states(), {STARTED: 'open', 'NOT-KILLED': 'open'});
	t.deepEqual(f.file(), ['STARTED', 'NOT-KILLED']);
});

test("a live process's start or close is left to it", async t => {
	const f = fixture(t);
	await f.mine.reserveStart('STARTING', ALIVE);
	await f.mine.add('CLOSING');
	await f.theirs.markClosing('CLOSING');
	const deps = settle([]);
	await f.mine.settle(deps);
	t.deepEqual(f.states(), {STARTING: 'starting', CLOSING: 'closing'});
	t.is(deps.asked, 0, 'tmux is only asked when there is something to settle');
});

test('this process finishes its own close once it is no longer running it', async t => {
	const f = fixture(t);
	await f.mine.add('A');
	await f.mine.markClosing('A');
	await f.mine.settle(settle([], ['A']));
	t.deepEqual(f.states(), {A: 'closing'});
	await f.mine.settle(settle([]));
	t.deepEqual(f.states(), {});
});

test('nothing is settled when tmux cannot say which sessions are alive', async t => {
	const f = fixture(t);
	await f.mine.reserveStart('STARTED', DEAD);
	await f.mine.settle(settle(null));
	t.deepEqual(f.states(), {STARTED: 'starting'});
});

// ============================================================================
// The registry file, written by a process without the database
// ============================================================================

test('the file decides which spaces are open, and says nothing about the rest', async t => {
	const f = fixture(t);
	await f.mine.add('KEPT');
	await f.mine.add('DROPPED');
	await f.mine.add('REOPENED');
	await f.theirs.markClosing('REOPENED');
	await f.mine.reserveStart('STARTING', ALIVE);
	fs.writeFileSync(
		f.registryFile,
		JSON.stringify(['KEPT', 'REOPENED', 'ADDED']),
	);
	t.deepEqual(f.mine.openSpaces(), ['KEPT', 'REOPENED', 'ADDED']);
	t.deepEqual(f.states(), {
		KEPT: 'open',
		REOPENED: 'open',
		STARTING: 'starting',
		ADDED: 'open',
	});
});

test('a registry file that cannot be read keeps the rows, and stops the reaper', async t => {
	const f = fixture(t);
	await f.mine.add('A');
	fs.writeFileSync(f.registryFile, '{');
	t.deepEqual(f.mine.openSpaces(), ['A']);
	t.false(f.mine.protectedSpaces().ok);
});

test('a registry file that vanished keeps the rows', async t => {
	const f = fixture(t);
	await f.mine.add('A');
	fs.rmSync(f.registryFile);
	t.deepEqual(f.mine.openSpaces(), ['A']);
	t.deepEqual(f.mine.protectedSpaces(), {ok: true, keys: ['A']});
});

test('a process with the database and one without both keep the space they add', async t => {
	const f = fixture(t);
	const withoutDatabase = new JsonSpaceRegistryDao(f.registryFile);
	await Promise.all(
		Array.from({length: 20}, async (_, index) =>
			index % 2 === 0
				? f.mine.add(`DB-${index}`)
				: withoutDatabase.add(`FILE-${index}`),
		),
	);
	const expected = Array.from({length: 20}, (_, index) =>
		index % 2 === 0 ? `DB-${index}` : `FILE-${index}`,
	).sort();
	t.deepEqual([...(f.mine.openSpaces() ?? [])].sort(), expected);
	t.deepEqual([...(withoutDatabase.openSpaces() ?? [])].sort(), expected);
});

// ============================================================================
// When the database cannot be used
// ============================================================================

test('a database that cannot be opened is a failed read, never an empty registry', t => {
	const {stateDir} = testState(t, {sqlite: true});
	const dbPath = path.join(stateDir, 'not-a-database.db');
	fs.writeFileSync(dbPath, 'this is not a database');
	const registry = new SqliteSpaceRegistryDao(
		() => openStateDb(dbPath),
		'repo',
		new JsonSpaceRegistryDao(getRegistryPathForRepo('repo', stateDir)),
	);
	t.false(registry.protectedSpaces().ok);
	t.throws(() => registry.openSpaces());
	t.true(
		registry.has('ANY'),
		'a space that cannot be looked up is assumed open',
	);
});

test('the reaper is stopped while the file is ahead of rows that cannot be updated', async t => {
	const f = fixture(t);
	await f.mine.add('A');
	fs.writeFileSync(f.registryFile, JSON.stringify(['A', 'B']));
	const other = new Database(f.dbPath);
	other.run('BEGIN IMMEDIATE');
	t.false(f.mine.protectedSpaces().ok);
	other.run('COMMIT');
	other.close();
	t.deepEqual(f.mine.protectedSpaces(), {ok: true, keys: ['A', 'B']});
});

test('a removal that cannot be written leaves the space closing, and the next settle removes it', async t => {
	const f = fixture(t);
	await f.mine.add('A');
	const other = new Database(f.dbPath);
	const result = await tearDownSpace('A', {
		markClosing: async key => f.mine.markClosing(key),
		reopen: async key => f.mine.reopen(key),
		async killSpaceSessions() {
			// From here another process holds the write lock past the deadline.
			other.run('BEGIN IMMEDIATE');
			return true;
		},
		removeSpace: async key => f.mine.remove(key),
		onKillFailure() {
			t.fail('the kill succeeded');
		},
	});
	other.run('COMMIT');
	other.close();

	t.is(result.outcome, 'unregister-failed');
	t.deepEqual(f.states(), {A: 'closing'});
	t.deepEqual(f.mine.openSpaces(), []);
	await f.mine.settle(settle([]));
	t.deepEqual(f.states(), {});
});

test('a space that cannot be recorded fails the script that asked, before it starts sessions', async t => {
	const f = fixture(t);
	f.mine.openSpaces();
	const other = new Database(f.dbPath);
	other.run('BEGIN IMMEDIATE');
	const failure = await t.throwsAsync(
		run(
			process.execPath,
			[
				new URL('state-cli.ts', import.meta.url).pathname,
				'prepare-space',
				'--repo',
				'repo',
				'--register',
				'--owner',
				String(process.pid),
				'NEW-1',
			],
			{
				env: {
					...process.env,
					PAPPARDELLE_SQLITE_STATE: '1',
					PAPPARDELLE_STATE_DB: f.dbPath,
				},
			},
		),
	);
	other.run('COMMIT');
	other.close();
	t.is((failure as {code?: number} | undefined)?.code, 1);
	t.deepEqual(f.states(), {});
});
