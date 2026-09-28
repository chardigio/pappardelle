export class StartupQueue {
	private readonly pending: Array<() => Promise<void>> = [];
	private active = 0;
	private scheduled = false;
	private stopped = false;

	constructor(private readonly concurrency = 2) {}

	async enqueue(task: () => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.stopped) {
				resolve();
				return;
			}
			this.pending.push(async () => {
				try {
					if (!this.stopped) await task();
					resolve();
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			this.schedule();
		});
	}

	stop(): void {
		this.stopped = true;
		// Let already-started workspaces finish, but don't launch queued work
		// after the owning UI has gone away.
		for (const task of this.pending.splice(0)) void task();
	}

	private schedule(): void {
		if (
			this.scheduled ||
			this.active >= this.concurrency ||
			!this.pending.length
		)
			return;
		this.scheduled = true;
		// Process creation itself can be slow under load. Start at most one
		// workspace per event-loop turn so input and rendering get a turn too.
		setImmediate(() => {
			this.scheduled = false;
			const task = this.pending.shift();
			if (!task) return;
			this.active++;
			void task().finally(() => {
				this.active--;
				this.schedule();
			});
			this.schedule();
		});
	}
}

/**
 * The queue exists to stop a watchlist burst from starting many `idow` runs at
 * once. A start the user asked for (the `n` key) must not wait behind that
 * burst, or behind two setups that hang in a hook, so it runs at once.
 */
export async function scheduleWorkspaceStart(
	queue: StartupQueue,
	task: () => Promise<void>,
	options: {queued: boolean},
): Promise<void> {
	return options.queued ? queue.enqueue(task) : task();
}
