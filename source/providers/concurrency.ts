/**
 * Run an array of async task factories with a concurrency limit.
 * Returns settled results in the same order as the input tasks.
 * Failed tasks produce `undefined` in the output — they do not abort
 * other in-flight tasks.
 */
export async function pLimit<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
): Promise<Array<T | undefined>> {
	const results: Array<T | undefined> = Array.from({
		length: tasks.length,
	}) as Array<T | undefined>;
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < tasks.length) {
			const index = nextIndex++;
			try {
				results[index] = await tasks[index]!();
			} catch {
				results[index] = undefined;
			}
		}
	}

	const workers = Array.from(
		{length: Math.min(concurrency, tasks.length)},
		async () => worker(),
	);
	await Promise.all(workers);
	return results;
}
