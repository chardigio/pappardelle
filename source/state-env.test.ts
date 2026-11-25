import {test, expect} from 'bun:test';
import {readStateEnv} from './state-env.ts';

test('only 1 and 0 override experimental.sqliteState', () => {
	expect(readStateEnv({PAPPARDELLE_SQLITE_STATE: '1'}).sqliteState).toBe(true);
	expect(readStateEnv({PAPPARDELLE_SQLITE_STATE: '0'}).sqliteState).toBe(false);
	expect(readStateEnv({PAPPARDELLE_SQLITE_STATE: 'true'}).sqliteState).toBe(
		undefined,
	);
	expect(readStateEnv({}).sqliteState).toBe(undefined);
});
