// The wire format of the Program Resume Protocol (OSC 7577, rev 0.5):
// https://www.superlogical.com/rex/docs/build/program-resume

import {Buffer} from 'node:buffer';
import {createHash, timingSafeEqual} from 'node:crypto';
import {decodeText} from './program-status.ts';
import {depthBelow, type ProcessInspector} from './process-tree.ts';

/** One of a space's panes that can hold records. */
export type ResumePane =
	| {kind: 'agent'}
	| {kind: 'main'}
	| {kind: 'split'; name: string};

/** A split name can't hold `:`, so a split named `agent` stays a split. */
export function resumePaneId(pane: ResumePane): string {
	return pane.kind === 'split' ? `split:${pane.name}` : pane.kind;
}

export function parseResumePaneId(id: string): ResumePane | undefined {
	if (id === 'agent' || id === 'main') return {kind: id};
	return id.startsWith('split:')
		? {kind: 'split', name: id.slice(6)}
		: undefined;
}

/** How far a report's time may be from the clock, in seconds. */
export const RESUME_TIME_WINDOW_S = 60;

const IMPLEMENTED_KEYS = new Set([
	'pid',
	'time',
	'mac',
	'argv',
	'cwd',
	'clear',
	'need',
]);

const NUMBER = /^[1-9]\d*$/;
const MAX_PID = 2 ** 31 - 1;
const TEXT_LIMIT = 4096;

/**
 * One outcome per case the spec defines. An ignored report changes nothing.
 * A rejected one passed the mac and time checks, so it still removes its
 * owner's records.
 */
export type ResumeReport =
	| {type: 'ignored'; reason: 'query' | 'mac' | 'time'}
	| {type: 'rejected'; reason: string; time: number; pid?: number}
	| {type: 'set'; pid: number; time: number; argv: string[]; cwd?: string}
	| {type: 'clear'; pid: number; time: number};

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function macMatches(signed: string, mac: string, token: string): boolean {
	return timingSafeEqual(
		Buffer.from(sha256(`${signed}:${token}`)),
		Buffer.from(mac),
	);
}

class Rejection extends Error {}

function reject(reason: string): never {
	throw new Rejection(reason);
}

function decode(value: string, key: string): string {
	try {
		return decodeText(value, TEXT_LIMIT, TEXT_LIMIT);
	} catch {
		return reject(key);
	}
}

function decodeArgv(value: string): string[] {
	const argv = value.split(',').map(element => decode(element, 'argv'));
	const program = argv[0]!;
	if (program === '') reject('argv empty');
	// `env` reads an element with `=` as an assignment, even a path, and
	// would run the next element in its place.
	if (program.includes('=')) reject('argv assignment');
	if (
		!program.startsWith('/') &&
		(program.includes('/') || program.startsWith('-'))
	)
		reject('argv program');
	return argv;
}

/** Verify one OSC 7577 body, the text between `7577;` and the terminator. */
export function verifyResumeReport(
	body: string,
	token: string,
	nowSeconds: number,
): ResumeReport {
	if (body === '?') return {type: 'ignored', reason: 'query'};
	const signedMatch = /^(.+):mac=([\da-f]{64})$/s.exec(body);
	if (!signedMatch || !macMatches(signedMatch[1]!, signedMatch[2]!, token))
		return {type: 'ignored', reason: 'mac'};
	const pairs = signedMatch[1]!.split(':');
	const timeValue = pairs.find(pair => pair.startsWith('time='))?.slice(5);
	const time = timeValue && NUMBER.test(timeValue) ? Number(timeValue) : NaN;
	if (
		!Number.isSafeInteger(time) ||
		Math.abs(time - nowSeconds) > RESUME_TIME_WINDOW_S
	)
		return {type: 'ignored', reason: 'time'};

	// Read before the strict parse, as time is: a report rejected for any
	// reason still names the owner whose records it removes.
	const pidValue = pairs.find(pair => pair.startsWith('pid='))?.slice(4);
	const pid =
		pidValue && NUMBER.test(pidValue) && Number(pidValue) <= MAX_PID
			? Number(pidValue)
			: undefined;
	const values = new Map<string, string>();
	try {
		for (const pair of pairs) {
			const match = /^([a-z]+)=([\w.,+/=-]*)$/.exec(pair);
			if (!match) reject('pair');
			const [, key, value] = match as unknown as [string, string, string];
			// The trailing mac is the one checked; another is a repeat of it.
			if (values.has(key) || key === 'mac') reject(`repeated ${key}`);
			values.set(key, value);
		}

		if (pid === undefined) reject('pid');

		const need = values.get('need');
		if (need !== undefined) {
			const keys = need.split(',');
			if (keys.some(key => !/^[a-z]+$/.test(key))) reject('need');
			if (keys.some(key => !IMPLEMENTED_KEYS.has(key))) reject('need unknown');
		}

		const argv = values.get('argv');
		const clear = values.get('clear');
		if ((argv === undefined) === (clear === undefined)) reject('argv or clear');
		if (clear !== undefined) {
			if (clear !== '1') reject('clear');
			if (values.has('cwd')) decode(values.get('cwd')!, 'cwd');
			return {type: 'clear', pid, time};
		}

		const report: ResumeReport = {
			type: 'set',
			pid,
			time,
			argv: decodeArgv(argv!),
		};
		const cwd = values.get('cwd');
		if (cwd !== undefined) {
			const directory = decode(cwd, 'cwd');
			if (!directory.startsWith('/')) reject('cwd relative');
			report.cwd = directory;
		}
		return report;
	} catch (error) {
		if (!(error instanceof Rejection)) throw error;
		return {
			type: 'rejected',
			reason: error.message,
			time,
			...(pid === undefined ? {} : {pid}),
		};
	}
}

export type ResumeReportFields = {pid: number; time: number} & (
	| {argv: string[]; cwd?: string; clear?: never}
	| {clear: true; argv?: never; cwd?: never}
);

/** The whole OSC 7577 sequence for `fields`, signed with `token`. */
export function buildResumeReport(
	fields: ResumeReportFields,
	token: string,
): string {
	const encode = (text: string) => Buffer.from(text).toString('base64');
	const pairs = [`pid=${fields.pid}`, `time=${fields.time}`];
	if (fields.clear) pairs.push('clear=1');
	else {
		pairs.push(`argv=${fields.argv.map(text => encode(text)).join(',')}`);
		if (fields.cwd !== undefined) pairs.push(`cwd=${encode(fields.cwd)}`);
	}
	const body = pairs.join(':');
	return `\u001B]7577;${body}:mac=${sha256(`${body}:${token}`)}\u001B\\`;
}

/** How long an owner that exited still counts as running. */
export const OWNER_EXIT_GRACE_MS = 2000;

export type ResumeRecord = {
	pid: number;
	/** The owner's start time, so a reused pid isn't taken for it. */
	started: string;
	uid: number;
	/** Parents between the owner and the pane's first process. */
	depth: number;
	time: number;
	argv: string[];
	cwd?: string;
	/** Whether the directory came from the report or from the OS. */
	cwdSource: 'report' | 'process';
};

/** A pane's records, and the last accepted report time of every pid. */
export type ResumeState = {
	records: ResumeRecord[];
	times: Record<number, number>;
};

export type ResumeTimers = {
	after(ms: number, run: () => void): () => void;
};

/** What a report did, for the monitor's log. Never holds argv or mac. */
export type ResumeOutcome =
	| 'accepted'
	| 'cleared'
	| `ignored: ${string}`
	| `rejected: ${string}`;

/** The record to restore: this user's shallowest, the latest on a tie. */
export function chooseResumeRecord(
	records: ResumeRecord[],
	uid: number,
): ResumeRecord | undefined {
	let chosen: ResumeRecord | undefined;
	for (const record of records) {
		if (record.uid !== uid) continue;
		if (
			!chosen ||
			record.depth < chosen.depth ||
			(record.depth === chosen.depth && record.time >= chosen.time)
		)
			chosen = record;
	}
	return chosen;
}

/** One resumable pane's records, kept by the pane's monitor. */
export class ResumeRecords {
	private readonly records = new Map<number, ResumeRecord>();
	private readonly times = new Map<number, number>();
	private readonly drops = new Map<number, () => void>();

	constructor(
		private readonly options: {
			panePid: number;
			uid: number;
			inspector: ProcessInspector;
			timers: ResumeTimers;
			save: (state: ResumeState) => void;
			initial?: ResumeState;
		},
	) {
		// A monitor starts with its pane, a moment before the launch clears the
		// records of the pane's last run, so it keeps only those whose owner
		// still runs under this pane.
		const initial = options.initial?.records ?? [];
		const processes =
			initial.length > 0 ? options.inspector.processes() : undefined;
		for (const record of initial)
			if (
				processes?.get(record.pid)?.started === record.started &&
				depthBelow(processes, record.pid, options.panePid) !== undefined
			)
				this.records.set(record.pid, record);
		for (const [pid, time] of Object.entries(options.initial?.times ?? {}))
			this.times.set(Number(pid), time);
	}

	handle(report: ResumeReport): ResumeOutcome {
		if (report.type === 'ignored') return `ignored: ${report.reason}`;
		if (report.type === 'rejected' && report.pid === undefined)
			return `rejected: ${report.reason}`;
		const {time} = report;
		const pid = report.pid!;
		if (time < (this.times.get(pid) ?? 0)) return 'ignored: stale';
		this.times.set(pid, time);
		this.cancelDrop(pid);
		if (report.type === 'rejected') {
			this.records.delete(pid);
			this.save();
			return `rejected: ${report.reason}`;
		}
		if (report.type === 'clear') {
			this.records.delete(pid);
			this.save();
			return 'cleared';
		}

		const processes = this.options.inspector.processes();
		const owner = processes.get(pid);
		const depth = owner && depthBelow(processes, pid, this.options.panePid);
		if (!owner || owner.uid !== this.options.uid || depth === undefined) {
			this.records.delete(pid);
			this.save();
			return 'rejected: owner';
		}
		const processCwd = report.cwd ? undefined : this.options.inspector.cwd(pid);
		this.records.set(pid, {
			pid,
			started: owner.started,
			uid: owner.uid,
			depth,
			time,
			argv: report.argv,
			...(report.cwd
				? {cwd: report.cwd, cwdSource: 'report' as const}
				: {
						...(processCwd ? {cwd: processCwd} : {}),
						cwdSource: 'process' as const,
					}),
		});
		this.save();
		return 'accepted';
	}

	/** Start the grace window of every owner that is no longer running. */
	checkOwners(): void {
		if (this.records.size === 0) return;
		const processes = this.options.inspector.processes();
		for (const record of this.records.values()) {
			const owner = processes.get(record.pid);
			if (owner?.started === record.started || this.drops.has(record.pid))
				continue;
			this.drops.set(
				record.pid,
				this.options.timers.after(OWNER_EXIT_GRACE_MS, () => {
					this.drops.delete(record.pid);
					this.records.delete(record.pid);
					this.save();
				}),
			);
		}
	}

	/** The pane or the server went away: what is stored is what restores. */
	stop(): void {
		for (const cancel of this.drops.values()) cancel();
		this.drops.clear();
	}

	state(): ResumeState {
		return {
			records: [...this.records.values()],
			times: Object.fromEntries(this.times),
		};
	}

	private cancelDrop(pid: number): void {
		this.drops.get(pid)?.();
		this.drops.delete(pid);
	}

	private save(): void {
		this.options.save(this.state());
	}
}
