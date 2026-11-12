import test from 'ava';
import {readStateEnv} from './state-env.ts';

test('only 1 and 0 override experimental.sqliteState', t => {
	t.is(readStateEnv({PAPPARDELLE_SQLITE_STATE: '1'}).sqliteState, true);
	t.is(readStateEnv({PAPPARDELLE_SQLITE_STATE: '0'}).sqliteState, false);
	t.is(readStateEnv({PAPPARDELLE_SQLITE_STATE: 'true'}).sqliteState, undefined);
	t.is(readStateEnv({}).sqliteState, undefined);
});
