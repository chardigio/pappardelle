// Claude hook statuses as the status daemon holds them: in memory only. The
// hook sends each event to the daemon, and this reads this process's copy.

import {
	readableStatusKey,
	statusInfo,
	type ClaudeStatusDao,
	type ClaudeStatusInfo,
	type StoredClaudeStatus,
} from './claude-status.ts';
import {firstChange, type StatusClient} from './status-client.ts';

/**
 * With no daemon running a key reads as never reported. That is what the
 * daemon itself answers after a restart, until each agent's next event.
 */
export class DaemonClaudeStatusDao implements ClaudeStatusDao {
	constructor(private readonly client: StatusClient) {}

	async readableKey(repoName: string, name: string): Promise<string> {
		return readableStatusKey(repoName, name, async statusKey => {
			const stored = await this.readState(statusKey);
			return stored.kind !== 'none';
		});
	}

	async read(statusKey: string): Promise<ClaudeStatusInfo | null> {
		const stored = await this.readState(statusKey);
		switch (stored.kind) {
			case 'state': {
				return statusInfo(stored.state);
			}

			case 'none': {
				return {status: 'unknown'};
			}

			case 'unreadable': {
				return null;
			}
		}
	}

	async readState(statusKey: string): Promise<StoredClaudeStatus> {
		await this.client.ready();
		const held = this.client.hook(statusKey);
		return held ? {kind: 'state', state: held} : {kind: 'none'};
	}

	watch(listener: (statusKey: string) => void): () => void {
		return this.client.onChange(change => {
			if (change.kind === 'hook') listener(change.statusKey);
		});
	}

	async waitForChange(ms: number): Promise<void> {
		return firstChange(listener => this.watch(listener), ms);
	}
}
