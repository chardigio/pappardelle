import {test, expect} from 'bun:test';
import {callerFromEnv} from './supervise-log.ts';

test("the caller is the agent's space, main for the main space's agent, else the user", () => {
	expect(
		callerFromEnv({PAPPARDELLE_SPACE: 'STA-1', PAPPARDELLE_REPO: 'r'}),
	).toBe('STA-1');
	expect(callerFromEnv({PAPPARDELLE_REPO: 'r'})).toBe('main');
	expect(callerFromEnv({})).toBe('user');
});
