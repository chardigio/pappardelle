/**
 * Several keys from one input write all run before React renders, so a
 * send or focus key can run before the attachment for a space just selected
 * with j/k is queued. Such a key waits here until that attachment is queued,
 * so it then runs behind the attachment instead of against the old space.
 */
export class AttachmentGate {
	private latest: string | undefined;
	private waiters: Array<() => void> = [];

	queued(space: string | undefined): void {
		this.latest = space;
		const {waiters} = this;
		this.waiters = [];
		for (const resolve of waiters) resolve();
	}

	async whenQueued(space: string): Promise<void> {
		if (this.latest === space) return;
		return new Promise(resolve => {
			this.waiters.push(resolve);
		});
	}
}
