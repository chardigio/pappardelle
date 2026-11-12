import {bunIsolationArgs, isStandalone} from './runtime.ts';
import {Buffer} from 'node:buffer';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
	existsSync,
	appendFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, promisify} from 'node:util';
import {
	ProgramStatusStore,
	TerminalStatusParser,
	parseProgramReport,
	type ProgramReport,
	type ProgramStatusInfo,
} from './program-status.ts';
import {waitForDirChange} from './file-watch.ts';
import {createLogger} from './logger.ts';

const execute = promisify(execFile);
const log = createLogger('program-status');
export const STATUS_MONITOR_OPTION = '@pappardelle_status_generation';
export const STATUS_PANE_OPTION = '@pappardelle_status_pane';
export type StatusTmuxRunner = (args: string[]) => Promise<string>;
export const runStatusTmux: StatusTmuxRunner = async args => {
	const result = await execute('tmux', args, {
		timeout: 5000,
		maxBuffer: 1024 * 1024,
	});
	return result.stdout;
};

export function statusSocket(env: NodeJS.ProcessEnv = process.env): string {
	return env['PAPPARDELLE_TMUX_SOCKET'] ?? 'pappardelle_inner';
}
export function statusTmuxArgs(
	args: string[],
	socket = statusSocket(),
): string[] {
	return socket.startsWith('/')
		? ['-S', socket, ...args]
		: ['-L', socket, ...args];
}
export function shellQuoteStatus(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function segment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}
/**
 * Where a repo's snapshots and leases are kept.
 * PAPPARDELLE_PROGRAM_STATUS_DIR moves them for a test or a timer service.
 */
export function programStatusDir(repo: string, stateDir: string): string {
	return path.join(
		process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'] ??
			path.join(stateDir, 'program-status'),
		segment(repo),
	);
}
export function programStatusPath(
	dir: string,
	key: string,
	generation: string,
): string {
	return path.join(dir, `${segment(key)}--${generation}.json`);
}
export function statusKeyFromFilename(filename: string): string | undefined {
	const match = /^(.*)--[a-f\d]{32}\.json$/.exec(filename);
	try {
		return match ? decodeURIComponent(match[1]!) : undefined;
	} catch {
		return undefined;
	}
}

export interface StatusPane {
	id: string;
	pid: string;
	dead: boolean;
	piped: boolean;
	marker: string;
	generation: string;
}
export function parseStatusPane(
	output: string,
	socket: string,
): StatusPane | null {
	const [id, pid, dead, piped, marker = ''] =
		output.trim().split('\n')[0]?.split('\t') ?? [];
	if (!id || !/^%\d+$/.test(id) || !pid || !/^\d+$/.test(pid)) return null;
	return {
		id,
		pid,
		dead: dead === '1',
		piped: piped === '1',
		marker,
		generation: createHash('sha256')
			.update(`${socket}:${id}:${pid}:${marker}`)
			.digest('hex')
			.slice(0, 32),
	};
}

export const STATUS_PANE_FORMAT = `#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_pipe}\t#{${STATUS_MONITOR_OPTION}}`;

export interface ProgramStatusSnapshot {
	version: 1;
	repo: string;
	key: string;
	pane: StatusPane;
	authoritative: boolean;
	exited: boolean;
	updatedAt: number;
	records: ProgramReport[];
	info: ProgramStatusInfo;
}

/**
 * What `load` returns when it is a snapshot `pane`'s monitor could have
 * written for this space, with the status a dead pane leaves behind.
 */
export function checkedProgramSnapshot(
	load: () => ProgramStatusSnapshot,
	repo: string,
	key: string,
	pane: StatusPane,
): ProgramStatusSnapshot | null {
	try {
		const value = load();
		if (
			value.version !== 1 ||
			value.repo !== repo ||
			value.key !== key ||
			value.pane?.generation !== pane.generation ||
			value.pane.id !== pane.id ||
			value.pane.pid !== pane.pid ||
			typeof value.authoritative !== 'boolean' ||
			!Array.isArray(value.records) ||
			value.records.length > 256 ||
			typeof value.exited !== 'boolean' ||
			!Number.isFinite(value.updatedAt)
		)
			return null;
		const store = new ProgramStatusStore();
		for (const report of value.records) {
			if (!report || typeof report.id !== 'string' || report.state === 'clear')
				return null;
			const fields = [`state=${report.state}`];
			if (report.id) fields.push(`id=${report.id}`);
			for (const name of ['app', 'kind', 'progress'] as const) {
				if (report[name] !== undefined) fields.push(`${name}=${report[name]}`);
			}
			for (const [name, wire] of [
				['message', 'msg'],
				['title', 'title'],
			] as const) {
				if (report[name] !== undefined) {
					if (typeof report[name] !== 'string') return null;
					fields.push(
						`${wire}=${Buffer.from(report[name]!).toString('base64')}`,
					);
				}
			}
			const parsed = parseProgramReport(fields.join(':'));
			if (!isDeepStrictEqual(parsed, report)) return null;
			store.apply(report);
		}
		if (!isDeepStrictEqual(value.info, store.status())) return null;
		if (pane.dead || value.exited) store.processExit();
		value.info = store.status();
		return value;
	} catch {
		return null;
	}
}

function monitorEntry(): string[] {
	if (isStandalone) return [process.execPath, '--internal-status-monitor'];
	const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
	const entry = fileURLToPath(
		new URL(`program-status-monitor-cli${extension}`, import.meta.url),
	);
	return [process.execPath, ...bunIsolationArgs, entry];
}

/** The status snapshots of one repo's agent panes. */
export interface ProgramStatusDao {
	/**
	 * Start the monitor of the session's status pane unless one is running,
	 * and return that pane.
	 */
	attach(
		key: string,
		session: string,
		socket?: string,
		run?: StatusTmuxRunner,
	): Promise<StatusPane | null>;
	/** Whether the monitor of this pane generation may still publish. */
	monitored(key: string, generation: string): boolean;
	read(key: string, pane: StatusPane): Promise<ProgramStatusSnapshot | null>;
	/**
	 * Revoke and delete the snapshots of a space, except `keepGeneration`'s.
	 * The leases are gone when this returns, before it resolves.
	 */
	remove(key: string, keepGeneration?: string): Promise<void>;
	/** Call `listener` with the space key of each snapshot that changes. */
	watch(listener: (key: string) => void): () => void;
	/** Resolve when a snapshot may have changed, or after `ms`. */
	waitForChange(ms: number): Promise<void>;
}

/** What attaching a monitor needs from the store its snapshots go to. */
type MonitorStore = {
	repo: string;
	dir: string;
	/**
	 * The status daemon's socket. A monitor is told where it is whatever the
	 * flag says, because it outlives a change of the flag and then starts or
	 * stops sending to the daemon by itself.
	 */
	socketPath: string;
	remove(key: string, keepGeneration?: string): Promise<void>;
};

export async function attachStatusMonitor(
	store: MonitorStore,
	key: string,
	session: string,
	socket = statusSocket(),
	run: StatusTmuxRunner = runStatusTmux,
): Promise<StatusPane | null> {
	const {repo, dir} = store;
	try {
		const target = `=${session}:`;
		// The pinned pane and the session's current pane in one call. They are
		// the same pane unless the session has grown a second one.
		const located = await run(
			statusTmuxArgs(
				[
					'display-message',
					'-p',
					'-t',
					target,
					`#{${STATUS_PANE_OPTION}}\t${STATUS_PANE_FORMAT}`,
				],
				socket,
			),
		);
		const [pinned = '', ...current] = (located.split('\n')[0] ?? '').split(
			'\t',
		);
		let pane = parseStatusPane(current.join('\t'), socket);
		if (pinned && pinned !== pane?.id)
			pane = parseStatusPane(
				await run(
					statusTmuxArgs(
						['display-message', '-p', '-t', pinned, STATUS_PANE_FORMAT],
						socket,
					),
				),
				socket,
			);
		if (!pane) return null;
		const pin = pinned
			? []
			: ['set-option', '-t', target, STATUS_PANE_OPTION, pane.id];
		if (pin.length > 0 && (pane.dead || pane.piped))
			await run(statusTmuxArgs(pin, socket));
		if (pane.dead) return pane;
		if (pane.piped) {
			if (!pane.marker.startsWith(`${pane.pid}.`))
				log.debug(
					`Status monitoring skipped for ${session}: pane already has a pipe`,
				);
			return pane;
		}
		const marker = `${pane.pid}.${randomUUID()}`;
		pane = parseStatusPane(`${pane.id}\t${pane.pid}\t0\t0\t${marker}`, socket)!;
		mkdirSync(dir, {recursive: true});
		const lease = `${programStatusPath(dir, key, pane.generation)}.lease`;
		writeFileSync(lease, '');
		const command = [
			...monitorEntry(),
			'watch',
			repo,
			key,
			socket,
			Buffer.from(JSON.stringify(pane)).toString('base64'),
			dir,
			process.env['PAPPARDELLE_PROGRAM_STATUS_TRACE_DIR'] ?? '',
			// pipe-pane starts the monitor with the tmux server's environment,
			// which may name another socket than this process uses.
			store.socketPath,
		]
			.map(value => shellQuoteStatus(value))
			.join(' ');
		const commands = [
			['set-option', '-p', '-t', pane.id, STATUS_MONITOR_OPTION, marker],
			[
				'pipe-pane',
				'-Oo',
				'-t',
				pane.id,
				command.replaceAll('%', '%%').replaceAll('#', '##'),
			],
		]
			.map(args => args.map(value => shellQuoteStatus(value)).join(' '))
			.join(' ; ');
		// The tmux command queue keeps the marker and pipe owned by the same
		// attachment, and the read that follows sees what it left.
		const attached = parseStatusPane(
			await run(
				statusTmuxArgs(
					[
						...pin,
						...(pin.length > 0 ? [';'] : []),
						'if-shell',
						'-F',
						'-t',
						pane.id,
						'#{pane_pipe}',
						'',
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
			// A session has one status pane, so earlier generations' files belong
			// to panes that no longer exist.
			await store.remove(key, pane.generation);
		} else {
			rmSync(lease, {force: true});
		}

		return attached;
	} catch (error) {
		log.debug(`Cannot monitor ${session}: ${String(error)}`);
		return null;
	}
}

export class JsonProgramStatusDao implements ProgramStatusDao {
	constructor(
		readonly repo: string,
		readonly dir: string,
		readonly socketPath: string,
	) {}

	async attach(
		key: string,
		session: string,
		socket?: string,
		run?: StatusTmuxRunner,
	): Promise<StatusPane | null> {
		return attachStatusMonitor(this, key, session, socket, run);
	}

	monitored(key: string, generation: string): boolean {
		return existsSync(`${programStatusPath(this.dir, key, generation)}.lease`);
	}

	async read(
		key: string,
		pane: StatusPane,
	): Promise<ProgramStatusSnapshot | null> {
		return checkedProgramSnapshot(
			() =>
				JSON.parse(
					readFileSync(
						programStatusPath(this.dir, key, pane.generation),
						'utf8',
					),
				) as ProgramStatusSnapshot,
			this.repo,
			key,
			pane,
		);
	}

	async remove(key: string, keepGeneration?: string): Promise<void> {
		this.removeFiles(key, keepGeneration);
	}

	removeFiles(key: string, keepGeneration?: string): void {
		try {
			const kept =
				keepGeneration === undefined
					? undefined
					: path.basename(programStatusPath(this.dir, key, keepGeneration));
			const files = readdirSync(this.dir).filter(
				file =>
					statusKeyFromFilename(file.replace(/\.lease$|\.tmp\.\d+$/g, '')) ===
						key &&
					(kept === undefined || !file.startsWith(kept)),
			);
			for (const file of files.filter(file => file.endsWith('.lease')))
				rmSync(path.join(this.dir, file), {force: true});
			for (const file of files.filter(file => !file.endsWith('.lease')))
				rmSync(path.join(this.dir, file), {force: true});
		} catch {}
	}

	watch(listener: (key: string) => void): () => void {
		mkdirSync(this.dir, {recursive: true});
		const watcher = watch(this.dir, (_event, filename) => {
			const key = filename ? statusKeyFromFilename(filename) : undefined;
			if (key !== undefined) listener(key);
		});
		return () => {
			watcher.close();
		};
	}

	async waitForChange(ms: number): Promise<void> {
		await waitForDirChange([this.dir], ms);
	}
}

/**
 * Write a pane's snapshot file for its readers. The lease is the pane's
 * permission to publish: closing a space deletes it, and a publisher that
 * was already writing then takes its own snapshot back.
 */
export function publishProgramSnapshot(
	dir: string,
	snapshot: ProgramStatusSnapshot,
): void {
	const target = programStatusPath(dir, snapshot.key, snapshot.pane.generation);
	const temp = `${target}.tmp.${process.pid}`;
	const leased = () => existsSync(`${target}.lease`);
	if (!leased()) return;
	try {
		writeFileSync(temp, JSON.stringify(snapshot));
		renameSync(temp, target);
		if (!leased()) rmSync(target, {force: true});
	} catch {
		try {
			rmSync(temp, {force: true});
		} catch {}
	}
}

/** Where a pane's monitor sends its snapshots. */
export interface SnapshotPublisher {
	publish(snapshot: ProgramStatusSnapshot): void;
	/**
	 * Runs on the monitor's liveness check. An agent can sit idle for hours,
	 * and its status still has to move when experimental.sqliteState changes.
	 */
	followFlag(): void;
	/** Settles once the last snapshot has gone out, or cannot. */
	close(): Promise<void>;
}

const PUBLISH_WINDOW_MS = 50;
const LIVENESS_CHECK_MS = 5000;

type WindowTimers = {
	now(): number;
	after(ms: number, run: () => void): () => void;
};

const realTimers: WindowTimers = {
	now: () => performance.now(),
	after(ms, run) {
		const timer = setTimeout(run, ms);
		return () => {
			clearTimeout(timer);
		};
	},
};

/**
 * When a pane's status goes out. A change after a quiet period is published
 * at once, so the rail follows the agent without a delay. Changes that come
 * within the window after a publish wait for its end and go out together,
 * which holds a chatty program to about 20 writes a second.
 */
export class PublishWindow {
	private cancelPending: (() => void) | undefined;
	private publishedAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly publish: () => void,
		private readonly timers: WindowTimers = realTimers,
	) {}

	request(): void {
		if (this.cancelPending) return;
		const wait = PUBLISH_WINDOW_MS - (this.timers.now() - this.publishedAt);
		if (wait <= 0) this.run();
		else this.cancelPending = this.timers.after(wait, () => this.run());
	}

	cancel(): void {
		this.cancelPending?.();
		this.cancelPending = undefined;
	}

	private run(): void {
		this.cancelPending = undefined;
		this.publishedAt = this.timers.now();
		this.publish();
	}
}

export function monitorPane(
	repo: string,
	key: string,
	socket: string,
	pane: StatusPane,
	dir: string,
	publisher: SnapshotPublisher,
	traceDir?: string,
): void {
	const store = new ProgramStatusStore();
	let changed = false;
	let exited = false;
	let stopped = false;
	let traceBytes = 0;
	const publish = () => {
		publisher.publish({
			version: 1,
			repo,
			key,
			pane,
			authoritative: store.authoritative,
			exited,
			updatedAt: Date.now(),
			records: store.records(),
			info: store.status(),
		});
	};
	const publishing = new PublishWindow(publish);
	const parser = new TerminalStatusParser(event => {
		if (traceDir) {
			try {
				mkdirSync(traceDir, {recursive: true});
				const trace = path.join(
					traceDir,
					`${segment(key)}--${pane.generation}.jsonl`,
				);
				const line = `${JSON.stringify({at: Date.now(), ...event})}\n`;
				traceBytes += Buffer.byteLength(line);
				if (traceBytes <= 1024 * 1024) appendFileSync(trace, line);
			} catch {}
		}
		if (event.type === 'query') return;
		if (event.type === 'report') store.apply(event.report);
		else if (event.type === 'prompt') store.processExit();
		else store.reset();
		changed = true;
	});
	const stop = () => {
		if (stopped) return;
		stopped = true;
		exited = true;
		publishing.cancel();
		clearInterval(liveness);
		store.processExit();
		publish();
		void publisher.close().then(() => {
			process.stdin.destroy();
		});
	};
	// A closed socket may not deliver EOF on every tmux version.
	const liveness = setInterval(() => {
		publisher.followFlag();
		void runStatusTmux(
			statusTmuxArgs(
				['display-message', '-p', '-t', pane.id, '#{pane_pid} #{pane_dead}'],
				socket,
			),
		)
			.then(value => {
				if (value.trim() !== `${pane.pid} 0`) stop();
			})
			.catch((error: unknown) => {
				log.debug(`Cannot check pane ${pane.id}: ${String(error)}`);
				try {
					process.kill(Number(pane.pid), 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ESRCH') stop();
				}
			});
	}, LIVENESS_CHECK_MS);
	process.stdin.on('data', (bytes: Buffer) => {
		parser.feed(bytes);
		// One read can hold several reports. Only the state after the last of
		// them is worth a write.
		if (!changed) return;
		changed = false;
		publishing.request();
	});
	process.stdin.on('end', stop);
	process.stdin.on('error', stop);
	process.once('SIGTERM', stop);
	process.once('SIGHUP', stop);
	if (!existsSync(programStatusPath(dir, key, pane.generation))) publish();
}
