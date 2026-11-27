import {Buffer} from 'node:buffer';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
	existsSync,
	appendFileSync,
	mkdirSync,
	readdirSync,
	rmSync,
} from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual, promisify} from 'node:util';
import {
	ProgramStatusStore,
	TerminalStatusParser,
	parseProgramReport,
	type ProgramReport,
	type ProgramStatusInfo,
} from './program-status.ts';
import {createLogger} from './logger.ts';
import type {
	MonitorStop,
	ResumeWatchArgs,
	ResumeWatcher,
} from './resume-monitor.ts';

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
/** tmux's flag for a socket: a path, or a name under tmux's own directory. */
export function statusSocketFlag(socket: string): '-S' | '-L' {
	return socket.startsWith('/') ? '-S' : '-L';
}

export function statusTmuxArgs(
	args: string[],
	socket = statusSocket(),
): string[] {
	return [statusSocketFlag(socket), socket, ...args];
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
/** Whether the pane may publish. Closing its space deletes the lease. */
export function programStatusLeased(
	dir: string,
	key: string,
	generation: string,
): boolean {
	return existsSync(`${programStatusPath(dir, key, generation)}.lease`);
}
/** The space key and pane generation a lease is named after. */
function leaseOf(
	filename: string,
): {key: string; generation: string} | undefined {
	const match = /^(.*)--([a-f\d]{32})\.json\.lease$/.exec(filename);
	if (!match) return undefined;
	try {
		return {key: decodeURIComponent(match[1]!), generation: match[2]!};
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
/** What a monitor marks its pane with: the pane's pid, then a fresh id. */
export function statusMarker(pid: string): string {
	return `${pid}.${randomUUID()}`;
}

/** The pid a pane had when its monitor marked it. */
export function markerPid(marker: string): string | undefined {
	return /^(\d+)\./.exec(marker)?.[1];
}

export function parseStatusPane(
	output: string,
	socket: string,
): StatusPane | null {
	const [id, listedPid, dead, piped, marker = ''] =
		output.trim().split('\n')[0]?.split('\t') ?? [];
	// tmux 3.8 lists no pid for a dead pane, and its monitor's snapshot is
	// filed under the pid the pane had.
	const pid = listedPid || (dead === '1' ? markerPid(marker) : undefined);
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

/**
 * A `list-panes` format for picking a session's status pane with
 * `statusPaneOf`: whether the pane is the session's current one, the pane
 * the session pinned, and the pane's status fields.
 */
export const AGENT_PANE_FORMAT = `#{window_active}#{pane_active}\t#{${STATUS_PANE_OPTION}}\t${STATUS_PANE_FORMAT}`;

export function selectedStatusPaneRow(lines: string[]): string | undefined {
	const rows = lines.map(line => {
		const [active = '', pinned = '', ...pane] = line.split('\t');
		return {current: active === '11', pinned, pane: pane.join('\t')};
	});
	const pinned = rows.find(row => row.pinned)?.pinned;
	return (
		pinned
			? rows.find(each => each.pane.startsWith(`${pinned}\t`))
			: rows.find(each => each.current)
	)?.pane;
}

/**
 * The pane the TUI's status monitor pinned, else the session's current pane,
 * from one session's `AGENT_PANE_FORMAT` lines.
 */
export function statusPaneOf(
	lines: string[],
	socket: string,
): StatusPane | null {
	const pane = selectedStatusPaneRow(lines);
	return pane ? parseStatusPane(pane, socket) : null;
}

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
 * `value` when it is a snapshot `pane`'s monitor could have written for this
 * space, with the status a dead pane leaves behind written into it.
 */
export function checkedProgramSnapshot(
	value: ProgramStatusSnapshot,
	repo: string,
	key: string,
	pane: StatusPane,
): ProgramStatusSnapshot | null {
	try {
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

/** A session's status pane: the pinned pane once pinned, else its current one. */
export interface LocatedStatusPane {
	pinned: string;
	pane: StatusPane | null;
}

const STATUS_LISTING_FORMAT = `#{session_name}\t#{&&:#{window_active},#{pane_active}}\t#{${STATUS_PANE_OPTION}}\t${STATUS_PANE_FORMAT}`;

export function parseStatusListing(
	output: string,
	socket: string,
): Map<string, LocatedStatusPane> {
	const panes = new Map<string, StatusPane>();
	const sessions = new Map<string, {pinned: string; current?: StatusPane}>();
	for (const line of output.split('\n')) {
		const [session, current, pinned = '', ...fields] = line.split('\t');
		if (!session) continue;
		const pane = parseStatusPane(fields.join('\t'), socket);
		if (pane) panes.set(pane.id, pane);
		const entry = sessions.get(session) ?? {pinned};
		// The active pane of the active window, which `=session:` targets.
		if (current === '1' && pane) entry.current = pane;
		sessions.set(session, entry);
	}
	return new Map(
		[...sessions].map(([session, {pinned, current}]) => [
			session,
			{pinned, pane: (pinned ? panes.get(pinned) : current) ?? null},
		]),
	);
}

/** Every session's status pane in one call; none when tmux can't answer. */
export async function listStatusPanes(
	socket = statusSocket(),
	run: StatusTmuxRunner = runStatusTmux,
): Promise<Map<string, LocatedStatusPane>> {
	try {
		return parseStatusListing(
			await run(
				statusTmuxArgs(
					['list-panes', '-a', '-F', STATUS_LISTING_FORMAT],
					socket,
				),
			),
			socket,
		);
	} catch (error) {
		log.debug(`Cannot list status panes: ${String(error)}`);
		return new Map();
	}
}

/** What a launch hands the agent pane's monitor for its resume records. */
export type MonitorResume = Pick<
	ResumeWatchArgs,
	'pane' | 'monitorTokenFile' | 'dbPath'
>;

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
		resume?: MonitorResume,
	): Promise<StatusPane | null>;
	/** `attach` for a pane already found by `listStatusPanes`. */
	monitor(
		key: string,
		session: string,
		located: LocatedStatusPane | undefined,
		socket?: string,
		run?: StatusTmuxRunner,
		resume?: MonitorResume,
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

/**
 * Revoke a space's leases except `keepGeneration`'s. Returns the pane
 * generations whose leases it removed.
 */
export function removeProgramStatusLeases(
	dir: string,
	key: string,
	keepGeneration?: string,
): string[] {
	const removed: string[] = [];
	try {
		for (const file of readdirSync(dir)) {
			const lease = leaseOf(file);
			if (lease?.key !== key || lease.generation === keepGeneration) continue;
			rmSync(path.join(dir, file), {force: true});
			removed.push(lease.generation);
		}
	} catch (error) {
		log.warn(
			`Could not remove every program status lease of ${key}`,
			error instanceof Error ? error : undefined,
		);
	}

	return removed;
}

/** Where a pane's monitor sends its snapshots. */
export interface SnapshotPublisher {
	publish(snapshot: ProgramStatusSnapshot): void;
	/** Settles once the last snapshot has gone out, or cannot. */
	close(): Promise<void>;
}

const PUBLISH_WINDOW_MS = 50;
export const LIVENESS_CHECK_MS = 5000;

type WindowTimers = {
	now(): number;
	after(ms: number, run: () => void): () => void;
};

export const realTimers: WindowTimers = {
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
	pane: StatusPane,
	publisher: SnapshotPublisher,
	traceDir?: string,
	resume?: ResumeWatcher,
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
		if (event.type === 'resume') {
			resume?.event(event);
			return;
		}
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
		else if (event.type === 'prompt') {
			store.processExit();
			resume?.event(event);
		} else store.reset();
		changed = true;
	});
	const stop = (why: MonitorStop) => {
		if (stopped) return;
		stopped = true;
		exited = true;
		resume?.stop(why);
		publishing.cancel();
		clearInterval(liveness);
		store.processExit();
		publish();
		void publisher.close().then(() => {
			process.stdin.destroy();
		});
	};
	// respawn-pane -k, and on tmux 3.4 a process exit under remain-on-exit,
	// leave the pipe open, so no EOF arrives. Usually the pane's process is
	// gone by then.
	const liveness = setInterval(() => {
		resume?.tick();
		try {
			process.kill(Number(pane.pid), 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') stop('eof');
		}
	}, LIVENESS_CHECK_MS);
	process.stdin.on('data', (bytes: Buffer) => {
		parser.feed(bytes);
		// One read can hold several reports. Only the state after the last of
		// them is worth a write.
		if (!changed) return;
		changed = false;
		publishing.request();
	});
	process.stdin.on('end', () => stop('eof'));
	process.stdin.on('error', () => stop('eof'));
	process.once('SIGTERM', () => stop('signal'));
	process.once('SIGHUP', () => stop('signal'));
	publish();
}
