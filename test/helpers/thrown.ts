import {expect} from 'bun:test';

type ErrorClass<E> = abstract new (...args: any[]) => E;

/**
 * What `fn` throws, for a test that goes on to check the error. Fails the
 * test when `fn` returns, or throws something that is not a `type` (an
 * Error unless given).
 */
export function thrownBy<E = Error>(
	fn: () => unknown,
	type?: ErrorClass<E>,
): E {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(type ?? Error);
		return error as E;
	}

	return expect.unreachable('expected a throw');
}

/** `thrownBy` for a promise: what it rejects with. */
export async function rejectionOf<E = Error>(
	promise: PromiseLike<unknown>,
	type?: ErrorClass<E>,
): Promise<E> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(type ?? Error);
		return error as E;
	}

	return expect.unreachable('expected a rejection');
}
