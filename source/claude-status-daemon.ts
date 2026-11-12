// Claude hook statuses as the status daemon holds them: in memory only. The
// hook sends each event to the daemon, and this reads this process's copy.

import {
	hookStatusKey,
	statusInfo,
	type ClaudeStatusDao,
	type ClaudeStatusInfo,
	type StoredClaudeStatus,
} from './claude-status.ts';
import {firstChange, type StatusClient} from './status-client.ts';

/**
 * With no daemon running every key reads as never reported. That is what the
 * daemon itself would answer after a restart, until each agent's next event.
 */
export class DaemonClaudeStatusDao implements ClaudeStatusDao {
	constructor(private readonly client: StatusClient) {}

	async readableKey(repoName: string, name: string): Promise<string> {
		await this.client.ready();
		const qualified = hookStatusKey(repoName, name);
		if (this.client.hook(qualified)) return qualified;
		return this.client.hook(name) ? name : qualified;
	}

	async read(statusKey: string): Promise<ClaudeStatusInfo> {
		const stored = await this.readState(statusKey);
		return stored.kind === 'state'
			? statusInfo(stored.state)
			: {status: 'unknown'};
	}

	async readState(statusKey: string): Promise<StoredClaudeStatus> {
		await this.client.ready();
		const state = this.client.hook(statusKey);
		return state ? {kind: 'state', state} : {kind: 'none'};
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
