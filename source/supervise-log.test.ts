import test from 'ava';
import {callerFromEnv} from './supervise-log.ts';

test("the caller is the agent's space, main for the main space's agent, else the user", t => {
	t.is(
		callerFromEnv({PAPPARDELLE_SPACE: 'STA-1', PAPPARDELLE_REPO: 'r'}),
		'STA-1',
	);
	t.is(callerFromEnv({PAPPARDELLE_REPO: 'r'}), 'main');
	t.is(callerFromEnv({}), 'user');
});
