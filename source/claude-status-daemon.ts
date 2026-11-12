// Claude hook statuses as the status daemon holds them: in memory only. The
// hook sends each event to the daemon, and this reads this process's copy.
//
// A status file can still be there beside it: the hook writes one while the
// flag is off, and deletes it once the daemon has an event of its own. A
// reader takes whichever of the two is newer, so a daemon that outlived an
// off period does not answer with what it held before it.

import {
	hookStatusKey,
	statusInfo,
	type ClaudeStatusDao,
	type ClaudeStatusInfo,
	type StoredClaudeStatus,
} from './claude-status.ts';
import {firstChange, type StatusClient} from './status-client.ts';

type StatusFiles = Pick<ClaudeStatusDao, 'readState'>;

/**
 * With no daemon running a key reads as its status file says, and as never
 * reported when it has none. That is what the daemon itself would answer after
 * a restart, until each agent's next event.
 */
export class DaemonClaudeStatusDao implements ClaudeStatusDao {
	constructor(
		private readonly client: StatusClient,
		private readonly files: StatusFiles,
	) {}

	async readableKey(repoName: string, name: string): Promise<string> {
		const qualified = hookStatusKey(repoName, name);
		const underQualified = await this.readState(qualified);
		if (underQualified.kind !== 'none') return qualified;
		const underName = await this.readState(name);
		return underName.kind === 'none' ? qualified : name;
	}

	async read(statusKey: string): Promise<ClaudeStatusInfo> {
		const stored = await this.readState(statusKey);
		return stored.kind === 'state'
			? statusInfo(stored.state)
			: {status: 'unknown'};
	}

	async readState(statusKey: string): Promise<StoredClaudeStatus> {
		await this.client.ready();
		const held = this.client.hook(statusKey);
		const file = await this.files.readState(statusKey);
		if (!held) return file;
		return file.kind === 'state' && file.state.lastUpdate > held.lastUpdate
			? file
			: {kind: 'state', state: held};
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
