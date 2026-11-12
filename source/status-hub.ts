// The status daemon's memory and its rule for each message. It does no I/O:
// the daemon hands it what arrived and sends what it returns.

import type {ClaudeSessionState} from './claude-status.ts';
import {SnapshotIndex} from './snapshot-index.ts';
import type {ClientMessage, DaemonMessage} from './status-protocol.ts';

export type Delivery<Subscriber> = {to: Subscriber; message: DaemonMessage};

/**
 * Nothing here is ever written down. A restarted daemon knows no hook status
 * until each agent's next hook event, and gets each pane's snapshot back when
 * its monitor reconnects.
 */
export class StatusHub<Subscriber> {
	/** By status key. Every repo's, because a status key names its repo. */
	private readonly hooks = new Map<string, ClaudeSessionState>();
	private readonly snapshotsByRepo = new Map<string, SnapshotIndex>();
	private readonly repoBySubscriber = new Map<Subscriber, string>();

	/**
	 * `daemon` names this daemon in every state it sends, so a client that
	 * reconnects can tell the daemon it was on from one that replaced it.
	 */
	constructor(private readonly daemon: string) {}

	/**
	 * Apply a message from `sender` and return what to send to whom. Only a
	 * connection that has subscribed is ever sent anything: a hook writes its
	 * line and closes without reading, and loses that line if the daemon has
	 * written to its connection first.
	 */
	receive(
		sender: Subscriber,
		message: ClientMessage,
	): Array<Delivery<Subscriber>> {
		switch (message.type) {
			case 'hook': {
				this.hooks.set(message.state.workspaceName, message.state);
				return this.toAll(message);
			}

			case 'restore': {
				// From a client that knew this before the daemon was replaced.
				// An agent's own event since then is the newer of the two.
				const held = this.hooks.get(message.state.workspaceName);
				if (held && held.lastUpdate >= message.state.lastUpdate) return [];
				this.hooks.set(message.state.workspaceName, message.state);
				return this.toAll({type: 'hook', state: message.state});
			}

			case 'snapshot': {
				const {repo} = message.snapshot;
				const snapshots = this.snapshotsByRepo.get(repo) ?? new SnapshotIndex();
				snapshots.keep(message.snapshot);
				this.snapshotsByRepo.set(repo, snapshots);
				return this.toRepo(repo, message);
			}

			case 'forget': {
				const {repo, key, keep} = message;
				this.snapshotsByRepo.get(repo)?.forget(key, keep);
				return this.toRepo(repo, {...message, type: 'forgotten'});
			}

			case 'subscribe': {
				this.repoBySubscriber.set(sender, message.repo);
				return [{to: sender, message: this.state(message.repo)}];
			}
		}
	}

	disconnect(subscriber: Subscriber): void {
		this.repoBySubscriber.delete(subscriber);
	}

	private state(repo: string): DaemonMessage {
		return {
			type: 'state',
			daemon: this.daemon,
			hooks: [...this.hooks.values()],
			snapshots: this.snapshotsByRepo.get(repo)?.all() ?? [],
		};
	}

	private toAll(message: DaemonMessage): Array<Delivery<Subscriber>> {
		return [...this.repoBySubscriber.keys()].map(to => ({to, message}));
	}

	private toRepo(
		repo: string,
		message: DaemonMessage,
	): Array<Delivery<Subscriber>> {
		return [...this.repoBySubscriber]
			.filter(([, subscribed]) => subscribed === repo)
			.map(([to]) => ({to, message}));
	}
}
