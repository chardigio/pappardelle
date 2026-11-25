import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readResolvedSqliteState, recordSqliteState} from './state-flag.ts';

function stateDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-flag-'));
	teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	return dir;
}

const recorded = (dir: string) =>
	JSON.parse(fs.readFileSync(path.join(dir, 'state-flag.json'), 'utf8')) as {
		sqliteState: boolean;
		db: string;
	};

test('a flag that was never on leaves no file behind', () => {
	const dir = stateDir();
	recordSqliteState(false, dir);
	expect(fs.readdirSync(dir)).toStrictEqual([]);
	expect(readResolvedSqliteState(dir, {})).toBe(false);
});

test('the recorded flag follows the config on, then off', () => {
	const dir = stateDir();
	recordSqliteState(true, dir);
	expect(recorded(dir)).toStrictEqual({
		sqliteState: true,
		db: path.join(dir, 'state.db'),
	});
	expect(readResolvedSqliteState(dir, {})).toBe(true);
	recordSqliteState(false, dir);
	expect(recorded(dir).sqliteState).toBe(false);
	expect(readResolvedSqliteState(dir, {})).toBe(false);
});

test('the override wins for the process that has it and is never recorded', () => {
	const dir = stateDir();
	recordSqliteState(false, dir);
	expect(readResolvedSqliteState(dir, {PAPPARDELLE_SQLITE_STATE: '1'})).toBe(
		true,
	);
	expect(fs.existsSync(path.join(dir, 'state-flag.json'))).toBe(false);

	recordSqliteState(true, dir);
	expect(readResolvedSqliteState(dir, {PAPPARDELLE_SQLITE_STATE: '0'})).toBe(
		false,
	);
	expect(recorded(dir).sqliteState).toBe(true);
});
