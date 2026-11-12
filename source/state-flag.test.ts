import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	readResolvedSqliteState,
	recordSqliteState,
	sqliteStateOverride,
} from './state-flag.ts';

function stateDir(t: {teardown(fn: () => void): void}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-flag-'));
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	return dir;
}

const recorded = (dir: string) =>
	JSON.parse(fs.readFileSync(path.join(dir, 'state-flag.json'), 'utf8')) as {
		sqliteState: boolean;
		db: string;
	};

test('a flag that was never on leaves no file behind', t => {
	const dir = stateDir(t);
	recordSqliteState(false, dir);
	t.deepEqual(fs.readdirSync(dir), []);
	t.false(readResolvedSqliteState(dir, {}));
});

test('the recorded flag follows the config on, then off', t => {
	const dir = stateDir(t);
	recordSqliteState(true, dir);
	t.deepEqual(recorded(dir), {
		sqliteState: true,
		db: path.join(dir, 'state.db'),
	});
	t.true(readResolvedSqliteState(dir, {}));
	recordSqliteState(false, dir);
	t.false(recorded(dir).sqliteState);
	t.false(readResolvedSqliteState(dir, {}));
});

test('the override wins for the process that has it and is never recorded', t => {
	const dir = stateDir(t);
	recordSqliteState(false, dir);
	t.true(readResolvedSqliteState(dir, {PAPPARDELLE_SQLITE_STATE: '1'}));
	t.false(fs.existsSync(path.join(dir, 'state-flag.json')));

	recordSqliteState(true, dir);
	t.false(readResolvedSqliteState(dir, {PAPPARDELLE_SQLITE_STATE: '0'}));
	t.true(recorded(dir).sqliteState);
});

test('only 1 and 0 are an override', t => {
	t.is(sqliteStateOverride({PAPPARDELLE_SQLITE_STATE: '1'}), true);
	t.is(sqliteStateOverride({PAPPARDELLE_SQLITE_STATE: '0'}), false);
	t.is(sqliteStateOverride({PAPPARDELLE_SQLITE_STATE: 'true'}), undefined);
	t.is(sqliteStateOverride({}), undefined);
});
