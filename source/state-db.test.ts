import test, {type ExecutionContext} from 'ava';
import {Database} from 'bun:sqlite';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {
	closeStateDb,
	isBusyError,
	openStateDb,
	type JsonMirror,
	type StateDb,
} from './state-db.ts';

const run = promisify(execFile);

function fixture(t: ExecutionContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-db-'));
	const dbPath = path.join(dir, 'state.db');
	const state = openStateDb(dbPath);
	state.db.run(
		'CREATE TABLE notes (file TEXT, name TEXT, body TEXT, PRIMARY KEY (file, name)) STRICT',
	);
	t.teardown(() => {
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

test('a write keeps the file and the rows the same, and a later read imports nothing', async t => {
	const {state, file} = fixture(t);
	const store = notes(state, file);
	await store.set('a', 'one');
	t.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {a: 'one'});
	t.deepEqual(store.read(), {a: 'one'});
	t.is(store.imports(), 0);
});

test('a file edited outside the database replaces its rows on the next read', async t => {
	const {state, file} = fixture(t);
	const store = notes(state, file);
	await store.set('a', 'one');
	fs.writeFileSync(file, JSON.stringify({a: 'edited', b: 'new'}));
	t.deepEqual(store.read(), {a: 'edited', b: 'new'});
	t.is(store.imports(), 1);
	store.read();
	t.is(store.imports(), 1);
});

test('the first write to a file that already exists keeps what was in it', async t => {
	const {state, file} = fixture(t);
	fs.writeFileSync(file, JSON.stringify({kept: 'from before'}));
	const store = notes(state, file);
	await store.set('added', 'now');
	t.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
		added: 'now',
		kept: 'from before',
	});
});

test('a file that is not readable as state keeps the stored rows', async t => {
	const {state, file} = fixture(t);
	const store = notes(state, file);
	await store.set('a', 'one');
	fs.writeFileSync(file, '{"a": "tru');
	t.is(state.sync(store.mirror), 'malformed');
	t.deepEqual(store.rows(), {a: 'one'});
	const importsAfterFirstLook = store.imports();
	t.is(state.sync(store.mirror), 'malformed');
	t.is(store.imports(), importsAfterFirstLook);
});

test('a transaction that fails after writing its file ends with rows that match the file', async t => {
	const {state, file} = fixture(t);
	const store = notes(state, file);
	await store.set('a', 'one');
	await t.throwsAsync(
		state.write(tx => {
			tx.sync(store.mirror);
			state.db
				.query('INSERT OR REPLACE INTO notes VALUES (?, ?, ?)')
				.run(file, 'a', 'two');
			tx.mirror(file, JSON.stringify({a: 'two'}));
			throw new Error('disk full');
		}),
		{message: 'disk full'},
	);
	t.deepEqual(store.rows(), {a: 'one'});
	t.deepEqual(store.read(), {a: 'two'});
});

test('removing a mirrored file forgets it, so a read does not import its absence', async t => {
	const {state, file} = fixture(t);
	const store = notes(state, file);
	await store.set('a', 'one');
	await state.write(tx => {
		state.db.query('DELETE FROM notes WHERE file = ?').run(file);
		tx.mirror(file, null);
	});
	t.false(fs.existsSync(file));
	t.deepEqual(store.read(), {});
	t.is(store.imports(), 0);
});

test('a write waits for another writer on a timer, without holding the event loop', async t => {
	const {state, dbPath, file} = fixture(t);
	const store = notes(state, file);
	const other = new Database(dbPath);
	other.run('BEGIN IMMEDIATE');
	const busy = t.throws(() => state.tryWrite(() => null));
	t.true(isBusyError(busy));

	let longestGap = 0;
	let last = performance.now();
	const ticker = setInterval(() => {
		const now = performance.now();
		longestGap = Math.max(longestGap, now - last);
		last = now;
	}, 5);
	setTimeout(() => {
		other.run('COMMIT');
	}, 400);
	await store.set('a', 'after the lock');
	clearInterval(ticker);
	other.close();

	t.deepEqual(store.rows(), {a: 'after the lock'});
	t.true(
		longestGap < 150,
		`the loop was held for ${longestGap.toFixed(0)} ms of a 400 ms lock`,
	);
});

test('a read that cannot take the lock serves the stored rows', async t => {
	const {state, dbPath, file} = fixture(t);
	const store = notes(state, file);
	await store.set('a', 'one');
	fs.writeFileSync(file, JSON.stringify({a: 'edited'}));
	const other = new Database(dbPath);
	other.run('BEGIN IMMEDIATE');
	t.is(state.sync(store.mirror), 'busy');
	t.deepEqual(store.rows(), {a: 'one'});
	other.run('COMMIT');
	other.close();
	t.deepEqual(store.read(), {a: 'edited'});
});

test('two processes opening a new database at once both end up with the schema', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-open-'));
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
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
		t.true(opened.tables.includes('json_sync'));
		t.is(opened.mode, 'wal');
	}
});
