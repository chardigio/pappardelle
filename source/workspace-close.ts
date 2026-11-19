/** Manual, bulk, and automatic close requests share the same in-flight teardown. */
export class WorkspaceCloseTasks {
	private readonly pending = new Map<string, Promise<boolean>>();

	/**
	 * Whether a close of `key` has started and not yet returned. A space being
	 * closed leaves the rail's list before its sessions are dead, so the list
	 * cannot say this.
	 */
	has(key: string): boolean {
		return this.pending.has(key);
	}

	async run(key: string, task: () => Promise<boolean>): Promise<boolean> {
		const existing = this.pending.get(key);
		if (existing) return existing;
		const result = Promise.resolve()
			.then(task)
			.finally(() => {
				this.pending.delete(key);
			});
		this.pending.set(key, result);
		return result;
	}
}
