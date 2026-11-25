import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf, thrownBy} from '../test/helpers/thrown.ts';
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
	openStateDb,
	stateDbPath,
	statusSocketPath,
	DEFAULT_STATE_DIR,
	type JsonMirror,
	type StateDb,
} from './state-db.ts';
import {sqliteRun} from '../test/helpers/state.ts';

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
	return {dir, dbPath, state, file: path.join(dir, 'notes.json')};
}

/** A store of name → body pairs mirrored in one JSON object. */
function notes(state: StateDb, file: string) {
	let imports = 0;
	const mirror: JsonMirror = {
		file,
		importRows(content) {
			imports++;
			// Deleting first means a bad file is only harmless if the import is
			// undone as a whole.
			state.db.query('DELETE FROM notes WHERE file = ?').run(file);
			const parsed: unknown = content === null ? {} : JSON.parse(content);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
				throw new Error('not a notes file');
			for (const [name, body] of Object.entries(parsed))
				state.db
					.query('INSERT INTO notes VALUES (?, ?, ?)')
					.run(file, name, String(body));
		},
	};
	const rows = () =>
		Object.fromEntries(
			state.db
				.query<{name: string; body: string}, [string]>(
					'SELECT name, body FROM notes WHERE file = ? ORDER BY name',
				)
				.all(file)
				.map(row => [row.name, row.body]),
		);
	return {
		mirror,
		rows,
		imports: () => imports,
		read() {
			state.sync(mirror);
			return rows();
		},
		async set(name: string, body: string) {
			await state.write(tx => {
				tx.sync(mirror);
				state.db
					.query('INSERT OR REPLACE INTO notes VALUES (?, ?, ?)')
					.run(file, name, body);
				tx.mirror(file, JSON.stringify(rows()));
			});
		},
	};
}

test('a write keeps the file and the rows the same, and a later read imports nothing', async () => {
	const {state, file} = fixture();
	const store = notes(state, file);
	await store.set('a', 'one');
	expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toStrictEqual({a: 'one'});
	expect(store.read()).toStrictEqual({a: 'one'});
	expect(store.imports()).toBe(0);
});

test('a file edited outside the database replaces its rows on the next read', async () => {
	const {state, file} = fixture();
	const store = notes(state, file);
	await store.set('a', 'one');
	fs.writeFileSync(file, JSON.stringify({a: 'edited', b: 'new'}));
	expect(store.read()).toStrictEqual({a: 'edited', b: 'new'});
	expect(store.imports()).toBe(1);
	store.read();
	expect(store.imports()).toBe(1);
});

test('the first write to a file that already exists keeps what was in it', async () => {
	const {state, file} = fixture();
	fs.writeFileSync(file, JSON.stringify({kept: 'from before'}));
	const store = notes(state, file);
	await store.set('added', 'now');
	expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toStrictEqual({
		added: 'now',
		kept: 'from before',
	});
});

test('a file that is not readable as state keeps the stored rows', async () => {
	const {state, file} = fixture();
	const store = notes(state, file);
	await store.set('a', 'one');
	fs.writeFileSync(file, '{"a": "tru');
	expect(state.sync(store.mirror)).toBe('malformed');
	expect(store.rows()).toStrictEqual({a: 'one'});
	const importsAfterFirstLook = store.imports();
	expect(state.sync(store.mirror)).toBe('malformed');
	expect(store.imports()).toBe(importsAfterFirstLook);
});

test('a transaction that fails after writing its file ends with rows that match the file', async () => {
	const {state, file} = fixture();
	const store = notes(state, file);
	await store.set('a', 'one');
	await rejectionOf(
		state.write(tx => {
			tx.sync(store.mirror);
			state.db
				.query('INSERT OR REPLACE INTO notes VALUES (?, ?, ?)')
				.run(file, 'a', 'two');
			tx.mirror(file, JSON.stringify({a: 'two'}));
			throw new Error('disk full');
		}),
	).then(error => {
		expect(error.message).toBe('disk full');
	});
	expect(store.rows()).toStrictEqual({a: 'one'});
	expect(store.read()).toStrictEqual({a: 'two'});
});

test('removing a mirrored file forgets it, so a read does not import its absence', async () => {
	const {state, file} = fixture();
	const store = notes(state, file);
	await store.set('a', 'one');
	await state.write(tx => {
		state.db.query('DELETE FROM notes WHERE file = ?').run(file);
		tx.mirror(file, null);
	});
	expect(fs.existsSync(file)).toBe(false);
	expect(store.read()).toStrictEqual({});
	expect(store.imports()).toBe(0);
});

test('a write waits for another writer on a timer, without holding the event loop', async () => {
	const {state, dbPath, file} = fixture();
	const store = notes(state, file);
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
	await store.set('a', 'after the lock');
	events.push('write landed');
	other.close();

	expect(events).toStrictEqual([
		'another timer ran',
		'lock released',
		'write landed',
	]);
	expect(store.rows()).toStrictEqual({a: 'after the lock'});
});

test('a read that cannot take the lock serves the stored rows', async () => {
	const {state, dbPath, file} = fixture();
	const store = notes(state, file);
	await store.set('a', 'one');
	fs.writeFileSync(file, JSON.stringify({a: 'edited'}));
	const other = new Database(dbPath);
	other.run('BEGIN IMMEDIATE');
	expect(state.sync(store.mirror)).toBe('busy');
	expect(store.rows()).toStrictEqual({a: 'one'});
	other.run('COMMIT');
	other.close();
	expect(store.read()).toStrictEqual({a: 'edited'});
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
		expect(opened.tables.includes('json_sync')).toBe(true);
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

(sqliteRun ? test : test.skip)(
	'a test run with the database on has its status socket with its database, outside the user’s state directory',
	() => {
		const directory = path.dirname(statusSocketPath(undefined, {}));

		expect(directory).toBe(path.dirname(stateDbPath(undefined, {})));
		expect(directory).not.toBe(DEFAULT_STATE_DIR);
	},
);
