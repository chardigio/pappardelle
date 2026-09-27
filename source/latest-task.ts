/** Serializes pane mutations while dropping superseded selections. */
export class LatestTask {
	private controller?: AbortController;
	private tail = Promise.resolve();

	async run(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
		this.cancel();
		const controller = new AbortController();
		this.controller = controller;
		const next = this.tail.then(async () => {
			if (!controller.signal.aborted) await task(controller.signal);
		});
		this.tail = next.catch(() => {});
		return next;
	}

	cancel(): void {
		this.controller?.abort();
	}

	/** Teardown must finish even if a newer selection supersedes attachment. */
	async exclusive<T>(task: () => Promise<T>): Promise<T> {
		const next = this.tail.then(task);
		this.tail = next.then(() => {}).catch(() => {});
		return next;
	}

	async idle(): Promise<void> {
		await this.tail;
	}
}
