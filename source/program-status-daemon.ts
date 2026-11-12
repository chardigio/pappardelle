// Program status as the status daemon holds it: in memory only. Each pane's
// monitor sends its snapshots to the daemon, and readers answer from this
// process's copy.
//
// A snapshot file can still be there beside it: a monitor started by a binary
// from before the daemon writes only files, and so does every monitor until
// it has seen the flag turn on. A reader takes whichever of the two is newer.
// Leases stay files, because a process with the flag off has to be able to
// revoke one.

import {rmSync} from 'node:fs';
import {
	attachStatusMonitor,
	checkedProgramSnapshot,
	JsonProgramStatusDao,
	programStatusDir,
	programStatusLeased,
	programStatusPath,
	publishProgramSnapshot,
	type ProgramStatusDao,
	type ProgramStatusSnapshot,
	type SnapshotPublisher,
	type StatusPane,
	type StatusTmuxRunner,
} from './program-status-monitor.ts';
import {firstChange, StatusClient} from './status-client.ts';
import {backgroundTimers, type StatusTimers} from './status-protocol.ts';

export class DaemonProgramStatusDao implements ProgramStatusDao {
	readonly repo: string;
	readonly dir: string;
	readonly socketPath: string;

	constructor(
		private readonly json: JsonProgramStatusDao,
		private readonly client: StatusClient,
	) {
		this.repo = json.repo;
		this.dir = json.dir;
		this.socketPath = json.socketPath;
	}

	async attach(
		key: string,
		session: string,
		socket?: string,
		run?: StatusTmuxRunner,
	): Promise<StatusPane | null> {
		return attachStatusMonitor(this, key, session, socket, run);
	}

	monitored(key: string, generation: string): boolean {
		return this.json.monitored(key, generation);
	}

	async read(
		key: string,
		pane: StatusPane,
	): Promise<ProgramStatusSnapshot | null> {
		await this.client.ready();
		const file = await this.json.read(key, pane);
		const held = this.client.snapshot(key, pane.generation);
		// The check rewrites the status of a snapshot whose pane has died, and
		// the copy this process holds is checked again on the next read.
		const sent = held
			? checkedProgramSnapshot(
					() => structuredClone(held),
					this.repo,
					key,
					pane,
				)
			: null;
		if (!sent) return file;
		return file && file.updatedAt >= sent.updatedAt ? file : sent;
	}

	/**
	 * This process's own copy drops the snapshots when the daemon tells its
	 * subscribers, a moment after this resolves.
	 */
	async remove(key: string, keepGeneration?: string): Promise<void> {
		this.json.removeFiles(key, keepGeneration);
		await this.client.send({
			type: 'forget',
			repo: this.repo,
			key,
			...(keepGeneration === undefined ? {} : {keep: keepGeneration}),
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

/**
 * A repo's program-status store. `statusClient` is the process's connection
 * to the status daemon when experimental.sqliteState is on. The `attach`
 * command builds its store without loading the config, so the two stores are
 * told apart here for it and for `createStateDaos` alike.
 */
export function createProgramStatusDao(options: {
	repo: string;
	stateDir: string;
	socketPath: string;
	statusClient: StatusClient | undefined;
}): ProgramStatusDao {
	const json = new JsonProgramStatusDao(
		options.repo,
		programStatusDir(options.repo, options.stateDir),
		options.socketPath,
	);
	return options.statusClient
		? new DaemonProgramStatusDao(json, options.statusClient)
		: json;
}

const FLAG_MAX_AGE_MS = 1000;

/**
 * How long a monitor whose pane has died waits for its last snapshot to be
 * written. A daemon that has stopped reading never takes it, and the monitor
 * of a pane that is gone must not stay for that.
 */
export const LAST_SEND_WAIT_MS = 2000;

type PublisherClient = Pick<StatusClient, 'send' | 'onConnect' | 'close'>;

export type FollowedPublisherOptions = {
	/** Where the pane's lease is, and its snapshot file while the flag is off. */
	dir: string;
	socketPath: string;
	/** experimental.sqliteState as it is now. */
	daemonMode: () => boolean;
	now?: () => number;
	timers?: StatusTimers;
	connect?: (socketPath: string) => PublisherClient;
};

/**
 * Where a monitor's snapshots go: to the status daemon while
 * experimental.sqliteState is on, to the pane's snapshot file while it is
 * off. A monitor lives as long as its agent pane, which can be days, so it
 * asks `daemonMode` again once what it was last told is a second old, and
 * moves its latest snapshot when the answer has changed.
 */
export function followedPublisher(
	options: FollowedPublisherOptions,
): SnapshotPublisher {
	const {dir, socketPath, daemonMode} = options;
	const now = options.now ?? (() => performance.now());
	const timers = options.timers ?? backgroundTimers;
	const connect =
		options.connect ??
		((daemonSocket: string) => new StatusClient(daemonSocket, {start: true}));
	let latest: ProgramStatusSnapshot | undefined;
	let client: PublisherClient | undefined;
	let lastSend: Promise<void> = Promise.resolve();
	let unsettledSends = 0;
	let readAt = Number.NEGATIVE_INFINITY;
	// A file written before the flag turned on. Left in place, it would be
	// shown as the pane's status when the flag is turned off again.
	let fileRemains = false;

	const send = (to: PublisherClient) => {
		const snapshot = latest;
		if (!snapshot) return;
		const {key, pane} = snapshot;
		if (!programStatusLeased(dir, key, pane.generation)) return;
		unsettledSends++;
		lastSend = to.send({type: 'snapshot', snapshot}).then(result => {
			unsettledSends--;
			if (result !== 'sent' || client !== to || !fileRemains) return;
			fileRemains = false;
			rmSync(programStatusPath(dir, key, pane.generation), {force: true});
		});
	};

	const write = () => {
		if (client) send(client);
		else if (latest) publishProgramSnapshot(dir, latest);
	};

	const followDestination = (): boolean => {
		if (now() - readAt < FLAG_MAX_AGE_MS) return false;
		readAt = now();
		const daemon = daemonMode();
		if (daemon === (client !== undefined)) return false;
		if (daemon) {
			const opened = connect(socketPath);
			client = opened;
			fileRemains = true;
			// A daemon that has just started holds nothing, and nothing was
			// kept for it while it could not be reached. A send that was
			// waiting for this connection is written to it, and is the latest.
			opened.onConnect(() => {
				if (unsettledSends === 0) send(opened);
			});
		} else {
			client!.close();
			client = undefined;
		}

		return true;
	};

	return {
		publish(snapshot) {
			latest = snapshot;
			followDestination();
			write();
		},
		followFlag() {
			if (followDestination()) write();
		},
		async close() {
			if (!client) return;
			const closing = client;
			await new Promise<void>(resolve => {
				const cancel = timers.after(LAST_SEND_WAIT_MS, resolve);
				void lastSend.then(() => {
					cancel();
					resolve();
				});
			});
			closing.close();
		},
	};
}
