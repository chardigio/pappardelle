import {setTimeout as delay} from 'node:timers/promises';

type Check = () => boolean | Promise<boolean>;

async function poll(
	check: Check,
	timeoutMs: number,
	intervalMs: number,
	failure: () => Error,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw failure();
		await delay(intervalMs);
	}
}

/** Polls until `check` holds; `frame` is printed when it never does. */
export async function until(
	check: Check,
	frame?: () => string | undefined,
	timeoutMs = 5000,
): Promise<void> {
	await poll(check, timeoutMs, 10, () => {
		const dump = frame?.();
		return new Error(
			dump === undefined
				? 'condition never held'
				: `condition never held\n${dump}`,
		);
	});
}

/** Poll until `predicate` holds. Throws, naming `what`, when it never does. */
export async function waitUntil(
	predicate: Check,
	what: string,
	timeoutMs = 5000,
): Promise<void> {
	await poll(
		predicate,
		timeoutMs,
		5,
		() => new Error(`Timed out waiting for ${what}`),
	);
}

/**
 * Let a new fs.watch watcher start delivering. On macOS it misses a write made
 * right after it is created; a watcher created at startup never meets that.
 */
export async function watcherReady(): Promise<void> {
	await delay(100);
}
