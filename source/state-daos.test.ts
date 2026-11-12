import fs from 'node:fs';
import test from 'ava';
import {testState} from '../test/helpers/state.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const autoCheckpointPages = (dbPath: string) =>
	openStateDb(dbPath)
		.db.query<{wal_autocheckpoint: number}, []>('PRAGMA wal_autocheckpoint')
		.get()?.wal_autocheckpoint;

test('deferring checkpoints waits for a store to open the database, then applies to that connection', async t => {
	const state = testState(t, {sqlite: true});
	const dbPath = stateDbPath(state.stateDir);

	state.daos.deferCheckpoints();
	t.false(fs.existsSync(dbPath));

	await state.daos.prLinkStamp.touch();
	t.is(autoCheckpointPages(dbPath), 0);
});

test('stores that were not asked to defer checkpoints keep SQLite’s own', async t => {
	const state = testState(t, {sqlite: true});
	await state.daos.prLinkStamp.touch();
	t.is(autoCheckpointPages(stateDbPath(state.stateDir)), 1000);
});

test('deferring checkpoints with the file-backed stores never creates a database', async t => {
	const state = testState(t, {sqlite: false});
	state.daos.deferCheckpoints();
	await state.daos.prLinkStamp.touch();
	t.false(fs.existsSync(stateDbPath(state.stateDir)));
});
