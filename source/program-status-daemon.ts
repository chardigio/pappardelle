// Program status as the status daemon holds it: in memory only. Each pane's
// monitor sends its snapshots to the daemon, and readers answer from this
// process's copy. A pane's lease is a file, and is its permission to publish:
// closing a space deletes it.

import {Buffer} from 'node:buffer';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {createLogger} from './logger.ts';
import {
	type LocatedStatusPane,
	type MonitorResume,
	checkedProgramSnapshot,
	listStatusPanes,
	markerPid,
	parseStatusPane,
	programStatusDir,
	programStatusLeased,
	programStatusPath,
	removeProgramStatusLeases,
	runStatusTmux,
	shellQuoteStatus,
	STATUS_MONITOR_OPTION,
	STATUS_PANE_FORMAT,
	STATUS_PANE_OPTION,
	statusMarker,
	statusSocket,
	statusTmuxArgs,
	type ProgramStatusDao,
	type SnapshotPublisher,
	type StatusPane,
	type StatusTmuxRunner,
	type ProgramStatusSnapshot,
} from './program-status-monitor.ts';
import {resumeWatchArgv} from './resume-monitor.ts';
import {internalEntryCommand} from './runtime.ts';
import {firstChange, StatusClient} from './status-client.ts';
import {backgroundTimers, type StatusTimers} from './status-protocol.ts';
import {tmuxFormatLiteral} from './tmux-format.ts';

const log = createLogger('program-status');

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
		resume?: MonitorResume,
	): Promise<StatusPane | null> {
		const panes = await listStatusPanes(socket, run);
		return this.monitor(key, session, panes.get(session), socket, run, resume);
	}

	async monitor(
		key: string,
		session: string,
		located: LocatedStatusPane | undefined,
		socket = statusSocket(),
		run: StatusTmuxRunner = runStatusTmux,
		resume?: MonitorResume,
	): Promise<StatusPane | null> {
		const {repo, dir} = this;
		try {
			if (!located?.pane) return null;
			const target = `=${session}:`;
			const {pinned} = located;
			let {pane} = located;
			const pin = pinned
				? []
				: ['set-option', '-t', target, STATUS_PANE_OPTION, pane.id];
			if (pin.length > 0 && (pane.dead || pane.piped))
				await run(statusTmuxArgs(pin, socket));
			if (pane.dead) return pane;
			if (pane.piped) {
				if (markerPid(pane.marker) !== pane.pid)
					log.debug(
						`Status monitoring skipped for ${session}: pane already has a pipe`,
					);
				return pane;
			}
			const marker = statusMarker(pane.pid);
			pane = parseStatusPane(
				`${pane.id}\t${pane.pid}\t0\t0\t${marker}`,
				socket,
			)!;
			mkdirSync(dir, {recursive: true});
			const lease = `${programStatusPath(dir, key, pane.generation)}.lease`;
			writeFileSync(lease, '');
			const command = [
				...internalEntryCommand(
					'--internal-status-monitor',
					'program-status-monitor-cli',
				),
				'watch',
				repo,
				key,
				Buffer.from(JSON.stringify(pane)).toString('base64'),
				dir,
				process.env['PAPPARDELLE_PROGRAM_STATUS_TRACE_DIR'] ?? '',
				// pipe-pane starts the monitor with the tmux server's environment,
				// which may name another socket than this process uses.
				this.socketPath,
				...(resume
					? resumeWatchArgv({
							...resume,
							repo,
							key,
							panePid: Number(pane.pid),
							tmuxPaneId: pane.id,
							tmuxSocket: socket,
						})
					: []),
			]
				.map(value => shellQuoteStatus(value))
				.join(' ');
			const commands = [
				...(pin.length > 0 ? [pin] : []),
				['set-option', '-p', '-t', pane.id, STATUS_MONITOR_OPTION, marker],
				[
					'pipe-pane',
					'-Oo',
					'-t',
					pane.id,
					tmuxFormatLiteral(command.replaceAll('%', '%%')),
				],
			]
				.map(args => args.map(value => shellQuoteStatus(value)).join(' '))
				.join(' ; ');
			// The tmux command queue keeps the pin, marker and pipe owned by the
			// same attachment, and the read that follows sees what it left. tmux
			// resolves a closed pane's id without error, so the condition checks
			// the pane still exists before pinning the session to it. `!:` needs
			// tmux 3.6, so the unpiped check is spelled with `==:`.
			const attached = parseStatusPane(
				await run(
					statusTmuxArgs(
						[
							'if-shell',
							'-F',
							'-t',
							pane.id,
							'#{&&:#{pane_id},#{==:#{pane_pipe},0}}',
							commands,
							';',
							'display-message',
							'-p',
							'-t',
							pane.id,
							STATUS_PANE_FORMAT,
						],
						socket,
					),
				),
				socket,
			);
			if (attached?.generation === pane.generation) {
				// A session has one status pane, so earlier generations' leases
				// belong to panes that no longer exist.
				await this.remove(key, pane.generation);
			} else {
				rmSync(lease, {force: true});
			}

			return attached;
		} catch (error) {
			log.debug(`Cannot monitor ${session}: ${String(error)}`);
			return null;
		}
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
			? checkedProgramSnapshot(structuredClone(held), this.repo, key, pane)
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
