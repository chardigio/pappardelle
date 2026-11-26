import {Database} from 'bun:sqlite';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf, thrownBy} from '../test/helpers/thrown.ts';
import {testState} from '../test/helpers/state.ts';
import {listOpenSpaces, type SettleDeps} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {tearDownSpace} from './space-utils.ts';
import {openStateDb, stateDbPath} from './state-db.ts';
import {WorkspaceCloseTasks} from './workspace-close.ts';

const run = promisify(execFile);

/** Identities for registries built by hand: every key named as idow names it. */
const named = {
	get: (key: string) =>
		({
			kind: 'identity',
			identity: newSpaceIdentity({
				repo: 'repo',
				key,
				worktreePath: `/w/${key}`,
				socket: 'pappardelle_inner',
			}),
		}) as const,
};
const ME = 111;
const ALIVE = 222;
const DEAD = 333;

/** A registry that believes it is process ME, beside one that is ALIVE. */
function fixture() {
	const {stateDir} = testState();
	const dbPath = stateDbPath(stateDir);
	const registry = (pid: number) =>
		new SqliteSpaceRegistryDao(
			() => openStateDb(dbPath),
			'repo',
			named,
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
	return {
		stateDir,
		dbPath,
		mine: registry(ME),
		theirs: registry(ALIVE),
		states,
	};
}

const settle = (
	live: string[] | null,
	closing: string[] = [],
): SettleDeps & {asked: number} => {
	const deps = {
		asked: 0,
		closing: new Set(closing),
		liveSessions() {
			deps.asked++;
			return (
				live &&
				new Set(live.map(key => named.get(key).identity.tmux.agentSession))
			);
		},
	};
	return deps;
};

// ============================================================================
// Starting: recorded before its sessions exist
// ============================================================================

test('a space being set up is not open, but it is there and its sessions are its own', async () => {
	const f = fixture();
	await f.mine.add('OPEN-1');
	await f.mine.reserveStart('NEW-1', ALIVE);
	expect(f.mine.openSpaces()).toStrictEqual(['OPEN-1']);
	expect(f.mine.has('NEW-1')).toBe(true);
	expect(f.mine.protectedSpaces()).toStrictEqual({
		ok: true,
		keys: ['OPEN-1', 'NEW-1'],
	});
});

test('opening a space that was being set up lists it', async () => {
	const f = fixture();
	await f.mine.reserveStart('NEW-1', ALIVE);
	await f.mine.add('NEW-1');
	expect(f.mine.openSpaces()).toStrictEqual(['NEW-1']);
});

test('setting up a space that is already open leaves it open', async () => {
	const f = fixture();
	await f.mine.add('OPEN-1');
	await f.mine.reserveStart('OPEN-1', ALIVE);
	expect(f.states()).toStrictEqual({'OPEN-1': 'open'});
});

// ============================================================================
// Closing: recorded before its sessions are killed
// ============================================================================

test('a space being closed leaves the list, and is still there', async () => {
	const f = fixture();
	await f.mine.add('A');
	await f.mine.add('B');
	await f.mine.markClosing('A');
	expect(f.mine.openSpaces()).toStrictEqual(['B']);
	expect(f.mine.has('A')).toBe(true);
	expect(f.mine.protectedSpaces()).toStrictEqual({ok: true, keys: ['A', 'B']});
	await f.mine.remove('A');
	expect(f.states()).toStrictEqual({B: 'open'});
});

test('a close whose kill failed puts the space back', async () => {
	const f = fixture();
	await f.mine.add('A');
	await f.mine.markClosing('A');
	await f.mine.reopen('A');
	expect(f.mine.openSpaces()).toStrictEqual(['A']);
});

// ============================================================================
// Settling what a process started and did not finish
// ============================================================================

test('a start or close whose owner died follows its sessions: alive is open, gone is removed', async () => {
	const f = fixture();
	await f.mine.reserveStart('STARTED', DEAD);
	await f.mine.reserveStart('NEVER-STARTED', DEAD);
	for (const key of ['KILLED', 'NOT-KILLED']) {
		// eslint-disable-next-line no-await-in-loop -- Order is part of the fixture.
		await f.mine.add(key);
	}

	const dead = new SqliteSpaceRegistryDao(
		() => openStateDb(f.dbPath),
		'repo',
		named,
		DEAD,
	);
	await dead.markClosing('KILLED');
	await dead.markClosing('NOT-KILLED');

	await f.mine.settle(settle(['STARTED', 'NOT-KILLED']));
	expect(f.states()).toStrictEqual({STARTED: 'open', 'NOT-KILLED': 'open'});
});

test("a live process's start or close is left to it", async () => {
	const f = fixture();
	await f.mine.reserveStart('STARTING', ALIVE);
	await f.mine.add('CLOSING');
	await f.theirs.markClosing('CLOSING');
	const deps = settle([]);
	await f.mine.settle(deps);
	expect(f.states()).toStrictEqual({STARTING: 'starting', CLOSING: 'closing'});
	expect(
		deps.asked,
		'tmux is only asked when there is something to settle',
	).toBe(0);
});

test('this process finishes its own close once it is no longer running it', async () => {
	const f = fixture();
	await f.mine.add('A');
	await f.mine.markClosing('A');
	await f.mine.settle(settle([], ['A']));
	expect(f.states()).toStrictEqual({A: 'closing'});
	await f.mine.settle(settle([]));
	expect(f.states()).toStrictEqual({});
});

// The rail refreshes while a close waits for tmux, and the space being closed
// has already left the rail's list by then.
test('a close this process is still running is left alone while its sessions are alive', async () => {
	const f = fixture();
	const closes = new WorkspaceCloseTasks();
	await f.mine.add('A');
	let marked = () => {};
	const closing = new Promise<void>(resolve => {
		marked = resolve;
	});
	let sessionsKilled = () => {};
	const close = closes.run('A', async () => {
		await f.mine.markClosing('A');
		marked();
		await new Promise<void>(resolve => {
			sessionsKilled = resolve;
		});
		await f.mine.remove('A');
		return true;
	});
	await closing;
	await f.mine.settle({
		closing: closes,
		liveSessions: () => new Set([named.get('A').identity.tmux.agentSession]),
	});
	expect(f.states()).toStrictEqual({A: 'closing'});
	sessionsKilled();
	await close;
	expect(f.states()).toStrictEqual({});
});

test('settle opens a starting space whose stored session is live and drops one whose sessions are gone', async () => {
	const state = testState();
	const {registry, spaceIdentities} = state.daos;
	for (const key of ['LIVE-1', 'GONE-1']) {
		// eslint-disable-next-line no-await-in-loop -- One store, written in turn.
		await spaceIdentities.record({
			repo: 'repo',
			key,
			worktreePath: `/w/${key}`,
			tmux: {
				socket: 'pappardelle_inner',
				agentSession: `hand-named-${key}`,
				companionSession: `hand-named-companion-${key}`,
			},
		});
		// Above any pid_max, so no process has it.
		// eslint-disable-next-line no-await-in-loop -- One store, written in turn.
		await registry.reserveStart(key, 99_999_999);
	}

	await registry.settle({
		closing: new Set(),
		liveSessions: () => new Set(['hand-named-LIVE-1', 'agent-repo-GONE-1']),
	});
	expect(registry.phase('LIVE-1')).toStrictEqual({
		kind: 'phase',
		phase: 'open',
	});
	expect(registry.phase('GONE-1')).toStrictEqual({kind: 'unknown'});
});

test('nothing is settled while a space being set up or torn down has no stored names', async () => {
	const state = testState();
	const {registry, spaceIdentities} = state.daos;
	await spaceIdentities.record({
		repo: 'repo',
		key: 'NAMED-1',
		worktreePath: '/w/NAMED-1',
		tmux: {
			socket: 'pappardelle_inner',
			agentSession: 'agent-repo-NAMED-1',
			companionSession: 'companion-repo-NAMED-1',
		},
	});
	// Above any pid_max, so no process has it.
	await registry.reserveStart('NAMED-1', 99_999_999);
	await registry.reserveStart('UNNAMED-1', 99_999_999);
	await registry.settle({closing: new Set(), liveSessions: () => new Set()});
	expect(registry.phase('NAMED-1')).toStrictEqual({
		kind: 'phase',
		phase: 'starting',
	});
	expect(registry.phase('UNNAMED-1')).toStrictEqual({
		kind: 'phase',
		phase: 'starting',
	});
});

test('nothing is settled when tmux cannot say which sessions are alive', async () => {
	const f = fixture();
	await f.mine.reserveStart('STARTED', DEAD);
	await f.mine.settle(settle(null));
	expect(f.states()).toStrictEqual({STARTED: 'starting'});
});

// ============================================================================
// Watchlist reservations: rows, changed with the spaces they count against
// ============================================================================

const isPidAlive = (pid: number) => pid !== DEAD;

function reservationFixture() {
	const f = fixture();
	return {
		...f,
		reservations: () =>
			Object.fromEntries(
				openStateDb(f.dbPath)
					.db.query<{key: string; source: string; owner_pid: number}, []>(
						`SELECT key, source, owner_pid FROM watchlist_reservations
						WHERE repo = 'repo' ORDER BY rowid`,
					)
					.all()
					.map(row => [row.key, `${row.source}:${row.owner_pid}`]),
			),
	};
}

// Slots are counted against the spaces that exist. If a space could be added
// between the count and the reservation, two instances could pass the cap.
test('no other connection can change the registry while slots are being decided', async () => {
	const f = reservationFixture();
	await f.mine.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
		pid: DEAD,
		isPidAlive,
	});
	const other = new Database(f.dbPath);
	teardown(() => {
		other.close();
	});
	other.run('PRAGMA busy_timeout = 0');
	const addSpace = () =>
		other.run(
			"INSERT INTO spaces (repo, key, state) VALUES ('repo', 'STE-1', 'open')",
		);
	let refused: unknown;
	const slots = await f.mine.tryReserveWatchlistSlots(
		'top-level',
		['STE-2'],
		1,
		{
			pid: ME,
			// Asked about STE-1's owner after the spaces were read and before
			// the reservations are written.
			isPidAlive(pid) {
				refused = thrownBy(addSpace);
				return isPidAlive(pid);
			},
		},
	);
	expect(refused).toMatchObject({code: 'SQLITE_BUSY'});
	expect(slots).toStrictEqual({
		reserved: ['STE-2'],
		occupied: 0,
		claimedElsewhere: [],
	});
	expect(addSpace).not.toThrow();
});

test('a space settled away frees the watchlist slot it reserved', async () => {
	const f = reservationFixture();
	await f.mine.tryReserveWatchlistSlots('top-level', ['GONE', 'KEPT'], 2, {
		pid: ME,
		isPidAlive,
	});
	await f.mine.reserveStart('GONE', DEAD);
	await f.mine.reserveStart('KEPT', DEAD);
	await f.mine.settle(settle(['KEPT']));
	expect(f.states()).toStrictEqual({KEPT: 'open'});
	expect(f.reservations()).toStrictEqual({KEPT: `top-level:${ME}`});
	expect(
		await f.mine.tryReserveWatchlistSlots('top-level', ['NEXT'], 2, {
			pid: ME,
			isPidAlive,
		}),
	).toStrictEqual({reserved: ['NEXT'], occupied: 1, claimedElsewhere: []});
});

test('a space whose reservation cannot be released stays registered', async () => {
	const f = reservationFixture();
	await f.mine.tryReserveWatchlistSlots('top-level', ['STE-1'], 1, {
		pid: ME,
		isPidAlive,
	});
	await f.mine.add('STE-1');
	openStateDb(f.dbPath).db.run(
		`CREATE TRIGGER reservations_are_stuck BEFORE DELETE ON watchlist_reservations
		BEGIN SELECT RAISE(ABORT, 'reservations are stuck'); END`,
	);
	expect(await rejectionOf(f.mine.remove('STE-1'))).toHaveProperty(
		'message',
		expect.stringMatching(/reservations are stuck/),
	);
	expect(f.states()).toStrictEqual({'STE-1': 'open'});
	expect(f.reservations()).toStrictEqual({'STE-1': `top-level:${ME}`});
});

// ============================================================================
// When the database cannot be used
// ============================================================================

test('a database that cannot be opened is a failed read, never an empty registry', () => {
	const {stateDir} = testState();
	const dbPath = path.join(stateDir, 'not-a-database.db');
	fs.writeFileSync(dbPath, 'this is not a database');
	const registry = new SqliteSpaceRegistryDao(
		() => openStateDb(dbPath),
		'repo',
		named,
	);
	expect(registry.protectedSpaces().ok).toBe(false);
	expect(() => registry.openSpaces()).toThrow();
	expect(listOpenSpaces(registry)).toStrictEqual([]);
	expect(registry.phase('ANY').kind).toBe('unreadable');
	expect(
		registry.has('ANY'),
		'a space that cannot be looked up is assumed open',
	).toBe(true);
});

test('a removal that cannot be written leaves the space closing, and the next settle removes it', async () => {
	const f = fixture();
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
			unreachable('the kill succeeded');
		},
	});
	other.run('COMMIT');
	other.close();

	expect(result.outcome).toBe('unregister-failed');
	expect(f.states()).toStrictEqual({A: 'closing'});
	expect(f.mine.openSpaces()).toStrictEqual([]);
	await f.mine.settle(settle([]));
	expect(f.states()).toStrictEqual({});
});

test('a space that cannot be recorded fails the script that asked, before it starts sessions', async () => {
	const f = fixture();
	f.mine.openSpaces();
	const other = new Database(f.dbPath);
	other.run('BEGIN IMMEDIATE');
	const failure = await rejectionOf(
		run(
			process.execPath,
			[
				new URL('state-cli.ts', import.meta.url).pathname,
				'prepare-space',
				'--repo',
				'repo',
				'--worktree',
				'/w/NEW-1',
				'--main-root',
				'/w/repo',
				'--register',
				'--owner',
				String(process.pid),
				'NEW-1',
			],
			{
				env: {
					...process.env,
					PAPPARDELLE_STATE_DB: f.dbPath,
				},
			},
		),
	);
	other.run('COMMIT');
	other.close();
	expect((failure as {code?: number} | undefined)?.code).toBe(3);
	expect(f.states()).toStrictEqual({});
});
