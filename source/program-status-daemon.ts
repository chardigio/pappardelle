// Program status as the status daemon holds it: in memory only. Each pane's
// monitor sends its snapshots to the daemon, and readers answer from this
// process's copy. A pane's lease is a file, and is its permission to publish:
// closing a space deletes it.

import {
	attachStatusMonitor,
	monitorStatusPane,
	type LocatedStatusPane,
	checkedProgramSnapshot,
	programStatusDir,
	programStatusLeased,
	removeProgramStatusLeases,
	type ProgramStatusDao,
	type SnapshotPublisher,
	type StatusPane,
	type StatusTmuxRunner,
	type ProgramStatusSnapshot,
} from './program-status-monitor.ts';
import {firstChange, StatusClient} from './status-client.ts';
import {backgroundTimers, type StatusTimers} from './status-protocol.ts';

export class DaemonProgramStatusDao implements ProgramStatusDao {
	constructor(
		readonly repo: string,
		/** Where the panes' leases are. */
		readonly dir: string,
		readonly socketPath: string,
		private readonly client: StatusClient,
	) {}

	async attach(
		key: string,
		session: string,
		socket?: string,
		run?: StatusTmuxRunner,
	): Promise<StatusPane | null> {
		return attachStatusMonitor(this, key, session, socket, run);
	}

	async monitor(
		key: string,
		session: string,
		located: LocatedStatusPane | undefined,
		socket?: string,
		run?: StatusTmuxRunner,
	): Promise<StatusPane | null> {
		return monitorStatusPane(this, key, session, located, socket, run);
	}

	monitored(key: string, generation: string): boolean {
		return programStatusLeased(this.dir, key, generation);
	}

	async read(
		key: string,
		pane: StatusPane,
	): Promise<ProgramStatusSnapshot | null> {
		await this.client.ready();
		const held = this.client.snapshot(key, pane.generation);
		// The check rewrites the status of a snapshot whose pane has died, and
		// the copy this process holds is checked again on the next read.
		return held
			? checkedProgramSnapshot(
					() => structuredClone(held),
					this.repo,
					key,
					pane,
				)
			: null;
	}

	/**
	 * This process's own copy drops the snapshots when the daemon tells its
	 * subscribers, a moment after this resolves.
	 */
	async remove(key: string, keepGeneration?: string): Promise<void> {
		const generations = removeProgramStatusLeases(
			this.dir,
			key,
			keepGeneration,
		);
		await this.client.send({
			type: 'forget',
			repo: this.repo,
			key,
			...(keepGeneration === undefined ? {} : {keep: keepGeneration}),
			generations,
		});
	}

	watch(listener: (key: string) => void): () => void {
		return this.client.onChange(change => {
			if (change.kind === 'snapshot') listener(change.key);
		});
	}

	async waitForChange(ms: number): Promise<void> {
		return firstChange(listener => this.watch(listener), ms);
	}
}

export function createProgramStatusDao(options: {
	repo: string;
	stateDir: string;
	socketPath: string;
	statusClient: StatusClient;
}): ProgramStatusDao {
	return new DaemonProgramStatusDao(
		options.repo,
		programStatusDir(options.repo, options.stateDir),
		options.socketPath,
		options.statusClient,
	);
}

/**
 * How long a monitor whose pane has died waits for its last snapshot to be
 * written. A daemon that has stopped reading never takes it, and the monitor
 * of a pane that is gone must not stay for that.
 */
export const LAST_SEND_WAIT_MS = 2000;

type PublisherClient = Pick<StatusClient, 'send' | 'onConnect' | 'close'>;

export type DaemonPublisherOptions = {
	/** Where the pane's lease is. */
	dir: string;
	socketPath: string;
	timers?: StatusTimers;
	connect?: (socketPath: string) => PublisherClient;
};

/** Where a monitor's snapshots go: to the status daemon. */
export function daemonPublisher(
	options: DaemonPublisherOptions,
): SnapshotPublisher {
	const {dir, socketPath} = options;
	const timers = options.timers ?? backgroundTimers;
	const connect =
		options.connect ??
		((daemonSocket: string) => new StatusClient(daemonSocket, {start: true}));
	let latest: ProgramStatusSnapshot | undefined;
	let lastSend: Promise<void> = Promise.resolve();
	let unsettledSends = 0;

	// Generations whose drop the daemon has taken, or is being sent.
	const dropped = new Set<string>();

	// A space's close can come between a lease check and the send after it,
	// and its forget then reach the daemon before the snapshot does.
	const drop = async (to: PublisherClient, snapshot: ProgramStatusSnapshot) => {
		const {repo, key, pane} = snapshot;
		if (dropped.has(pane.generation)) return;
		dropped.add(pane.generation);
		lastSend = to
			.send({type: 'drop', repo, key, generation: pane.generation})
			.then(result => {
				if (result !== 'sent') dropped.delete(pane.generation);
			});
		return lastSend;
	};

	const send = (to: PublisherClient) => {
		const snapshot = latest;
		if (!snapshot) return;
		const {key, pane} = snapshot;
		if (!programStatusLeased(dir, key, pane.generation)) {
			void drop(to, snapshot);
			return;
		}

		unsettledSends++;
		lastSend = to.send({type: 'snapshot', snapshot}).then(async result => {
			unsettledSends--;
			if (result !== 'sent') return;
			if (!programStatusLeased(dir, key, pane.generation))
				await drop(to, snapshot);
		});
	};

	const client = connect(socketPath);
	// A daemon that has just started holds nothing, and nothing was kept for it
	// while it could not be reached. A send that was waiting for this
	// connection is written to it, and is the latest.
	client.onConnect(() => {
		if (unsettledSends === 0) send(client);
	});

	return {
		publish(snapshot) {
			latest = snapshot;
			send(client);
		},
		async close() {
			await new Promise<void>(resolve => {
				const cancel = timers.after(LAST_SEND_WAIT_MS, resolve);
				void lastSend.then(() => {
					cancel();
					resolve();
				});
			});
			client.close();
		},
	};
}
