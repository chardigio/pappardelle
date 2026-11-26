import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {thrownBy} from '../test/helpers/thrown.ts';
import {Database} from 'bun:sqlite';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {
	checkpoint,
	checkpointOutsideWrites,
	closeStateDb,
	isBusyError,
	listKnownRepos,
	openStateDb,
	stateDbPath,
	statusSocketPath,
	DEFAULT_STATE_DIR,
	type StateDb,
} from './state-db.ts';

const run = promisify(execFile);

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-db-'));
	const dbPath = path.join(dir, 'state.db');
	const state = openStateDb(dbPath);
	state.db.run(
		'CREATE TABLE notes (file TEXT, name TEXT, body TEXT, PRIMARY KEY (file, name)) STRICT',
	);
	teardown(() => {
		closeStateDb(dbPath);
		fs.rmSync(dir, {recursive: true, force: true});
	});
	return {dbPath, state};
}

test('a write waits for another writer on a timer, without holding the event loop', async () => {
	const {state, dbPath} = fixture();
	const other = new Database(dbPath);
	other.run('BEGIN IMMEDIATE');
	const busy = thrownBy(() => state.tryWrite(() => null));
	expect(isBusyError(busy)).toBe(true);

	// The lock is released by a timer in this process. A write that waited
	// inside the database would keep that timer from ever running, and would
	// fail at its own deadline with the lock still held.
	const events: string[] = [];
	setTimeout(() => {
		events.push('another timer ran');
	}, 30);
	setTimeout(() => {
		other.run('COMMIT');
		events.push('lock released');
	}, 300);
	await state.write(() =>
		state.db
			.query('INSERT INTO notes VALUES (?, ?, ?)')
			.run('notes', 'a', 'after the lock'),
	);
	events.push('write landed');
	other.close();

	expect(events).toStrictEqual([
		'another timer ran',
		'lock released',
		'write landed',
	]);
	expect(state.db.query('SELECT body FROM notes').all()).toStrictEqual([
		{body: 'after the lock'},
	]);
});

test('two processes opening a new database at once both end up with the schema', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-open-'));
	teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	const dbPath = path.join(dir, 'state.db');
	const script = `
		import {openStateDb} from ${JSON.stringify(new URL('state-db.ts', import.meta.url).href)};
		const {db} = openStateDb(${JSON.stringify(dbPath)});
		console.log(JSON.stringify({
			tables: db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name),
			mode: db.query('PRAGMA journal_mode').get().journal_mode,
		}));
	`;
	const outputs = await Promise.all(
		Array.from({length: 4}, async () =>
			run(process.execPath, ['--input-type=module', '-e', script]),
		),
	);
	for (const {stdout} of outputs) {
		const opened = JSON.parse(stdout) as {tables: string[]; mode: string};
		expect(opened.tables.includes('json_import')).toBe(true);
		expect(opened.mode).toBe('wal');
	}
});

/** Commit `commits` rows of about one page each, one transaction per row. */
function fill(state: StateDb, commits: number): void {
	const insert = state.db.query(
		'INSERT INTO notes (file, name, body) VALUES (?, ?, ?)',
	);
	for (let index = 0; index < commits; index++)
		insert.run('filler', String(index), 'x'.repeat(4000));
}

// SQLite checkpoints inside the commit that takes the log past 1000 pages,
// which is two fsyncs on the thread that committed.
test('a connection that checkpoints outside its writes never checkpoints in a commit', () => {
	const deferred = fixture();
	const standard = fixture();
	checkpointOutsideWrites(deferred.state);
	const size = (dbPath: string) => fs.statSync(dbPath).size;
	const before = size(deferred.dbPath);

	fill(deferred.state, 1500);
	fill(standard.state, 1500);

	expect(size(deferred.dbPath)).toBe(before);
	expect(size(standard.dbPath) > 1_000_000).toBe(true);
	expect(size(`${deferred.dbPath}-wal`) > 1500 * 4096).toBe(true);

	checkpoint(deferred.state);
	expect(size(deferred.dbPath) > 1500 * 4000).toBe(true);
});

test('the status socket is beside the database, unless the variable or a state directory names another place', () => {
	const moved = {PAPPARDELLE_STATE_DB: '/moved/state.db'};
	const named = {...moved, PAPPARDELLE_STATUS_SOCKET: '/named/daemon.sock'};

	expect(statusSocketPath(undefined, moved)).toBe('/moved/status-1.sock');
	expect(statusSocketPath(undefined, named)).toBe('/named/daemon.sock');
	expect(statusSocketPath('/explicit', named)).toBe('/explicit/status-1.sock');
});

test('a test run has its status socket with its database, outside the user’s state directory', () => {
	const directory = path.dirname(statusSocketPath(undefined, {}));

	expect(directory).toBe(path.dirname(stateDbPath(undefined, {})));
	expect(directory).not.toBe(DEFAULT_STATE_DIR);
});

test('an empty variable is the default database and socket, not a temporary database', () => {
	const empty = {PAPPARDELLE_STATE_DB: '', PAPPARDELLE_STATUS_SOCKET: ''};

	expect(stateDbPath(undefined, empty)).toBe(stateDbPath(undefined, {}));
	expect(statusSocketPath(undefined, empty)).toBe(
		statusSocketPath(undefined, {}),
	);
});

test('a repo is known by its rows in the database or by its directory under repos', () => {
	const stateDir = tempDir('papp-known-repos-');
	const dbPath = path.join(stateDir, 'state.db');
	teardown(() => {
		closeStateDb(dbPath);
	});
	fs.mkdirSync(path.join(stateDir, 'repos', 'from-files'), {recursive: true});
	const {db} = openStateDb(dbPath);
	db.query(
		`INSERT INTO spaces (repo, key, state) VALUES ('open-space', 'A-1', 'open')`,
	).run();
	db.query(
		`INSERT INTO tui_markers (repo, pid, cli_path, sha, pane_id, started_at)
		VALUES ('tui-only', 1, '/cli', 'sha', '%1', 1)`,
	).run();

	expect(listKnownRepos(dbPath, stateDir)).toEqual([
		'from-files',
		'open-space',
		'tui-only',
	]);
});
