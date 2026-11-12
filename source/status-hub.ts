// The status daemon's memory and its rule for each message. It does no I/O:
// the daemon hands it what arrived and sends what it returns.

import type {ClaudeSessionState} from './claude-status.ts';
import type {ProgramStatusSnapshot} from './program-status-monitor.ts';
import type {ClientMessage, DaemonMessage} from './status-protocol.ts';

/** A message for one subscriber. */
export type Delivery<Subscriber> = {to: Subscriber; message: DaemonMessage};

/**
 * Nothing here is ever written down. A restarted daemon knows no hook status
 * until each agent's next hook event, and gets each pane's snapshot back when
 * its monitor reconnects.
 */
export class StatusHub<Subscriber> {
	/** By status key. Every repo's, because a status key names its repo. */
	private readonly hooks = new Map<string, ClaudeSessionState>();
	/** By repo, then space key, then pane generation. */
	private readonly snapshots = new Map<
		string,
		Map<string, Map<string, ProgramStatusSnapshot>>
	>();

	/** The repo each subscriber asked for. */
	private readonly subscribers = new Map<Subscriber, string>();

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
				const {repo, key, pane} = message.snapshot;
				const spaces = this.snapshots.get(repo) ?? new Map();
				const generations = spaces.get(key) ?? new Map();
				generations.set(pane.generation, message.snapshot);
				spaces.set(key, generations);
				this.snapshots.set(repo, spaces);
				return this.toRepo(repo, message);
			}

			case 'forget': {
				const {repo, key, keep} = message;
				const generations = this.snapshots.get(repo)?.get(key);
				for (const generation of generations?.keys() ?? []) {
					if (generation !== keep) generations!.delete(generation);
				}

				return this.toRepo(repo, {...message, type: 'forgotten'});
			}

			case 'subscribe': {
				this.subscribers.set(sender, message.repo);
				return [{to: sender, message: this.state(message.repo)}];
			}
		}
	}

	disconnect(subscriber: Subscriber): void {
		this.subscribers.delete(subscriber);
	}

	private state(repo: string): DaemonMessage {
		return {
			type: 'state',
			hooks: [...this.hooks.values()],
			snapshots: [...(this.snapshots.get(repo)?.values() ?? [])].flatMap(
				generations => [...generations.values()],
			),
		};
	}

	private toAll(message: DaemonMessage): Array<Delivery<Subscriber>> {
		return [...this.subscribers.keys()].map(to => ({to, message}));
	}

	private toRepo(
		repo: string,
		message: DaemonMessage,
	): Array<Delivery<Subscriber>> {
		return [...this.subscribers]
			.filter(([, subscribed]) => subscribed === repo)
			.map(([to]) => ({to, message}));
	}
}
