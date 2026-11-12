import test, {type ExecutionContext, type ImplementationFn} from 'ava';
import {testState, type TestState} from './state.ts';

/**
 * Declare one test per store implementation. A DAO's contract is whatever
 * passes on both: the file-backed store and the one experimental.sqliteState
 * selects (SQLite, or the status daemon for hook and program status) must be
 * indistinguishable to their callers.
 */
export function contractTest(
	title: string,
	run: (t: ExecutionContext, state: TestState) => Promise<void> | void,
): void {
	for (const [name, sqlite] of [
		['json', false],
		['sqlite', true],
	] as const) {
		const implementation: ImplementationFn<[]> = async t =>
			run(t, testState(t, {sqlite}));
		test(`${name}: ${title}`, implementation);
	}
}
