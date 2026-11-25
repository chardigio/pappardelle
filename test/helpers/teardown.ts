import {onTestFinished} from 'bun:test';

type Step = () => unknown;

let steps: Step[] | undefined;

/**
 * Undo something when the running test ends, pass or fail. Steps run last
 * registered first, so a server is stopped before the directory it lives in
 * is removed, and every step runs even when one throws; the first error then
 * fails the test.
 */
export function teardown(step: Step): void {
	if (steps === undefined) {
		const registered: Step[] = [];
		steps = registered;
		onTestFinished(async () => {
			steps = undefined;
			let failure: {error: unknown} | undefined;
			for (const each of registered.reverse()) {
				try {
					await each();
				} catch (error) {
					failure ??= {error};
				}
			}

			if (failure) throw failure.error;
		});
	}

	steps.push(step);
}
