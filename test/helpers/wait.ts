import {setTimeout as delay} from 'node:timers/promises';

/** Poll until `predicate` holds. Throws, naming `what`, when it never does. */
export async function waitUntil(
	predicate: () => boolean,
	what: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		// eslint-disable-next-line no-await-in-loop -- Polling.
		await delay(5);
	}
}

/**
 * Let a new fs.watch watcher start delivering. On macOS it misses a write made
 * right after it is created; a watcher created at startup never meets that.
 */
export async function watcherReady(): Promise<void> {
	await delay(100);
}
