import {test} from 'bun:test';
import {testState, type TestState} from './state.ts';

/** A test with stores of its own on a temp directory. */
export function storeTest(
	title: string,
	run: (state: TestState) => Promise<void> | void,
): void {
	test(title, async () => run(testState()));
}
