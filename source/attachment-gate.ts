/**
 * Several keys from one input write all run before React renders, so a
 * send or focus key can run before the attachment for a space just selected
 * with j/k is queued. Such a key waits here for the next render, so it then
 * runs behind that attachment instead of against the old space.
 */
export class AttachmentGate {
	private latest: string | undefined;
	private waiters: Array<() => void> = [];

	rendered(space: string | undefined): void {
		this.latest = space;
		const {waiters} = this;
		this.waiters = [];
		for (const resolve of waiters) resolve();
	}

	async whenRendered(space: string): Promise<void> {
		if (this.latest === space) return;
		return new Promise(resolve => {
			this.waiters.push(resolve);
		});
	}
}
