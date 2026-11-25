import {expect} from 'bun:test';
import {teardown} from './teardown.ts';

/**
 * `expect.unreachable` for a stub a test hands to the code under test. That
 * code may catch the throw, so a call also fails the test when it ends, as
 * ava's t.fail did.
 */
export function unreachable(message: string): never {
	teardown(() => {
		throw new Error(message);
	});
	return expect.unreachable(message);
}
