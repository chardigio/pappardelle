import {setTimeout as delay} from 'node:timers/promises';

/** How long a wait on a real tmux server may take on a loaded CI runner. */
export const REAL_TMUX_TIMEOUT_MS = 30_000;

export type WaitOptions = {
	/** Names the wait in the failure: "Timed out waiting for <what>". */
	what?: string;
	/** Printed under the failure, e.g. the last frame. */
	frame?: () => string | undefined;
	/** Default 5000. */
	timeoutMs?: number;
	/** Default 5. A read that spawns a process passes its own. */
	intervalMs?: number;
};

/** Polls read until accept holds for its value, and returns that value. */
export async function untilValue<T>(
	read: () => T | Promise<T>,
	accept: (value: T) => boolean,
	options: WaitOptions = {},
): Promise<T> {
	const {
		what = 'the condition',
		frame,
		timeoutMs = 5000,
		intervalMs = 5,
	} = options;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (accept(value)) return value;
		if (Date.now() > deadline) {
			const detail = frame ? frame() : `last value: ${Bun.inspect(value)}`;
			throw new Error(
				detail === undefined
					? `Timed out waiting for ${what}`
					: `Timed out waiting for ${what}\n${detail}`,
			);
		}

		await delay(intervalMs);
	}
}

/** Polls until check holds. */
export async function until(
	check: () => boolean | Promise<boolean>,
	options: WaitOptions = {},
): Promise<void> {
	await untilValue(check, Boolean, {
		...options,
		frame: options.frame ?? (() => undefined),
	});
}

/**
 * Let a new fs.watch watcher start delivering. On macOS it misses a write made
 * right after it is created; a watcher created at startup never meets that.
 */
export async function watcherReady(): Promise<void> {
	await delay(100);
}
