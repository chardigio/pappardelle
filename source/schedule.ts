// Wake-ups for a supervised space: a message at a set time, `continue` once a
// Codex usage limit resets, or a job that keeps an agent working by nudging it
// when it sits idle. Jobs live in ~/.pappardelle/repos/{repo}/schedules/, and
// an OS user timer runs `pappardelle schedule fire ID` for each.

import type {SendToSpaceAgentResult} from './tmux.ts';
import {randomUUID} from 'node:crypto';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {AgentStateReport} from './agent-state.ts';

type OneShot = {
	id: string;
	key: string;
	at: string;
	message: string;
	/**
	 * Counts the timers this job has had. A job that has to try again, or
	 * whose limit moved later, keeps its id but needs a new timer, and the
	 * running timer's unit still holds the old name.
	 */
	arm: number;
};

export type Job =
	| ({kind: 'at'} & OneShot)
	| ({kind: 'after_limit'} & OneShot)
	| {
			kind: 'keep_going';
			id: string;
			key: string;
			everySeconds: number;
			nudge: string;
			until: string | null;
			idleChecks: number;
	  };

export type TimerWhen = {at: Date} | {everySeconds: number};

export type FireResult =
	| 'sent'
	| 'waiting'
	| 'retrying'
	| 'skipped_working'
	| 'skipped_draft'
	| 'no_session'
	| 'expired';

export type SendOutcome = SendToSpaceAgentResult;

// Codex can refuse a message sent the second its limit resets.
export const RESET_MARGIN_MS = 60_000;
// How soon a one-shot whose send was refused, say over a draft, tries again.
export const RETRY_MS = 5 * 60_000;
// The idle check after which keep_going nudges, as 3wf.sh did: one idle
// check can catch an agent between two turns.
const IDLE_CHECKS_BEFORE_NUDGE = 2;

/** One repo's scheduled jobs, and the message queued for each space's next send. */
export interface ScheduleDao {
	save(job: Job): Promise<void>;
	load(id: string): Job | null;
	list(): Job[];
	delete(id: string): Promise<void>;
	/** Replace the text a space's next scheduled send carries. */
	queue(key: string, text: string): Promise<void>;
	queued(key: string): string | null;
	clearQueued(key: string): Promise<void>;
}

export function schedulesDir(repoName: string, baseDir: string): string {
	return path.join(baseDir, 'repos', repoName, 'schedules');
}

export function queuedMessagesDir(repoName: string, baseDir: string): string {
	return path.join(baseDir, 'repos', repoName, 'queued');
}

export function newJobId(): string {
	return randomUUID().slice(0, 8);
}

export function renderJob(job: Job): string {
	return JSON.stringify(job, null, '\t') + '\n';
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** A job file as `save` leaves it. Throws when `content` is anything else. */
export function parseJob(content: string): Job {
	const job = (JSON.parse(content) ?? {}) as Record<string, unknown>;
	const {kind, id, key} = job;
	if (!isString(id) || !isString(key)) throw new Error('Not a scheduled job');
	if (kind === 'keep_going') {
		const {everySeconds, nudge, until, idleChecks} = job;
		if (
			!Number.isInteger(everySeconds) ||
			!isString(nudge) ||
			!(until === null || isString(until)) ||
			!Number.isInteger(idleChecks)
		)
			throw new Error('Not a keep-going job');
		return {
			kind,
			id,
			key,
			everySeconds: everySeconds as number,
			nudge,
			until,
			idleChecks: idleChecks as number,
		};
	}

	const {at, message, arm} = job;
	if (
		(kind !== 'at' && kind !== 'after_limit') ||
		!isString(at) ||
		!isString(message) ||
		!Number.isInteger(arm)
	)
		throw new Error('Not a scheduled job');
	return {kind, id, key, at, message, arm: arm as number};
}

export class JsonScheduleDao implements ScheduleDao {
	constructor(
		private readonly jobsDir: string,
		private readonly queueDir: string,
	) {}

	jobFile(id: string): string {
		return path.join(this.jobsDir, `${id}.json`);
	}

	queueFile(key: string): string {
		return path.join(this.queueDir, `${encodeURIComponent(key)}.txt`);
	}

	/** The ids of the job files on disk. */
	ids(): string[] {
		let files: string[];
		try {
			files = readdirSync(this.jobsDir);
		} catch {
			return [];
		}

		return files
			.filter(file => file.endsWith('.json'))
			.map(file => file.slice(0, -5));
	}

	async save(job: Job): Promise<void> {
		mkdirSync(this.jobsDir, {recursive: true});
		const file = this.jobFile(job.id);
		writeFileSync(`${file}.tmp`, renderJob(job));
		// Renamed into place, so a timer firing mid-write never reads half a job.
		renameSync(`${file}.tmp`, file);
	}

	load(id: string): Job | null {
		try {
			return JSON.parse(readFileSync(this.jobFile(id), 'utf8')) as Job;
		} catch {
			return null;
		}
	}

	list(): Job[] {
		return this.ids()
			.map(id => this.load(id))
			.filter((job): job is Job => job !== null);
	}

	async delete(id: string): Promise<void> {
		rmSync(this.jobFile(id), {force: true});
	}

	async queue(key: string, text: string): Promise<void> {
		mkdirSync(this.queueDir, {recursive: true});
		writeFileSync(this.queueFile(key), text);
	}

	queued(key: string): string | null {
		try {
			return readFileSync(this.queueFile(key), 'utf8');
		} catch {
			return null;
		}
	}

	async clearQueued(key: string): Promise<void> {
		rmSync(this.queueFile(key), {force: true});
	}
}

const DURATION = /^(\d+)([smh])$/;

export function parseDuration(text: string): number | null {
	const match = DURATION.exec(text.trim());
	if (!match) return null;
	return Number(match[1]) * {s: 1, m: 60, h: 3600}[match[2] as 's' | 'm' | 'h'];
}

/** An ISO time, or `HH:MM` meaning its next occurrence. */
export function parseWhen(text: string, now: Date): Date | null {
	const clock = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (clock) {
		if (Number(clock[1]) > 23 || Number(clock[2]) > 59) return null;
		const at = new Date(now);
		at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
		if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
		return at;
	}

	const at = new Date(text);
	return Number.isNaN(at.getTime()) ? null : at;
}

/** When `continue` can go: the limit's reset plus a margin. */
export function limitLiftsAt(report: AgentStateReport): Date | null {
	const reset = report.usageLimit?.resetAt;
	return reset ? new Date(reset.getTime() + RESET_MARGIN_MS) : null;
}

export type FireDeps = {
	store: ScheduleDao;
	now: Date;
	readState: (key: string) => Promise<AgentStateReport>;
	send: (key: string, text: string) => Promise<SendOutcome>;
	/** Escape on Codex's offer to switch models, which keeps the current one. */
	dismissModelSwitch: (key: string) => Promise<void>;
	createTimer: (job: Job) => void;
	/** Removes the job's timer once the job is done. */
	removeTimer: (job: Job) => void;
};

async function sendNext(
	job: Job,
	text: string,
	report: AgentStateReport,
	deps: FireDeps,
): Promise<SendOutcome> {
	if (report.codexDialog?.kind === 'model_switch') {
		await deps.dismissModelSwitch(job.key);
	}

	const queued = deps.store.queued(job.key);
	const outcome = await deps.send(job.key, queued ?? text);
	// Only once it's out, so a refused send keeps it for the next try.
	if (outcome === 'sent' && queued !== null) {
		await deps.store.clearQueued(job.key);
	}

	return outcome;
}

async function finish(job: Job, deps: FireDeps): Promise<void> {
	await deps.store.delete(job.id);
	deps.removeTimer(job);
}

async function rearm(
	job: Extract<Job, {kind: 'at' | 'after_limit'}>,
	at: Date,
	deps: FireDeps,
): Promise<void> {
	const next = {...job, at: at.toISOString(), arm: job.arm + 1};
	await deps.store.save(next);
	deps.createTimer(next);
	deps.removeTimer(job);
}

/** The state under Codex's model-switch offer, which a wake-up dismisses. */
function underModelSwitch(report: AgentStateReport): AgentStateReport['state'] {
	if (report.codexDialog?.kind !== 'model_switch') return report.state;
	return report.usageLimit ? 'usage_limit' : 'idle';
}

async function fireOneShot(
	job: Extract<Job, {kind: 'at' | 'after_limit'}>,
	deps: FireDeps,
): Promise<FireResult> {
	const {now} = deps;
	const report = await deps.readState(job.key);
	if (report.state === 'no_session') {
		await finish(job, deps);
		return 'no_session';
	}

	if (job.kind === 'after_limit') {
		const lifts = limitLiftsAt(report);
		if (lifts && lifts > now) {
			await rearm(job, lifts, deps);
			return 'waiting';
		}
	}

	// Codex keeps the limit message on screen after the reset until
	// something is sent, so a passed reset sends even though it's showing.
	const outcome = await sendNext(job, job.message, report, deps);
	if (outcome === 'sent') {
		await finish(job, deps);
		return 'sent';
	}

	if (outcome === 'no-session') {
		await finish(job, deps);
		return 'no_session';
	}

	await rearm(job, new Date(now.getTime() + RETRY_MS), deps);
	return 'retrying';
}

function nudgeResult(outcome: SendOutcome): FireResult {
	if (outcome === 'sent') return 'sent';
	return outcome === 'draft' ? 'skipped_draft' : 'waiting';
}

export async function fireJob(job: Job, deps: FireDeps): Promise<FireResult> {
	if (job.kind !== 'keep_going') return fireOneShot(job, deps);
	const {now} = deps;
	if (job.until && new Date(job.until) <= now) {
		await finish(job, deps);
		return 'expired';
	}

	const report = await deps.readState(job.key);
	const save = async (idleChecks: number) =>
		deps.store.save({...job, idleChecks});
	switch (underModelSwitch(report)) {
		case 'working': {
			await save(0);
			return 'skipped_working';
		}

		case 'draft': {
			return 'skipped_draft';
		}

		case 'usage_limit': {
			const lifts = limitLiftsAt(report);
			if (!lifts || lifts > now) return 'waiting';
			await save(0);
			return nudgeResult(await sendNext(job, 'continue', report, deps));
		}

		case 'idle': {
			const idleChecks = job.idleChecks + 1;
			if (idleChecks < IDLE_CHECKS_BEFORE_NUDGE) {
				await save(idleChecks);
				return 'waiting';
			}

			await save(0);
			return nudgeResult(await sendNext(job, job.nudge, report, deps));
		}

		case 'permission':
		case 'question':
		case 'auth':
		case 'dialog':
		case 'no_session': {
			// The supervising agent's to answer.
			await save(0);
			return 'waiting';
		}
	}
}

// A job whose time passed while its timer was gone fires this soon after.
const LATE_FIRE_MS = 60_000;

/**
 * Gives every saved job without a timer a new one: systemd's transient timers
 * don't survive a reboot, while the job files do. Returns the jobs re-armed.
 */
export async function rearmMissingTimers(
	store: ScheduleDao,
	timers: {exists(job: Job): boolean; create(job: Job, when: TimerWhen): void},
	now: Date,
): Promise<Job[]> {
	const rearmed: Job[] = [];
	for (const job of store.list()) {
		if (timers.exists(job)) continue;
		let next = job;
		if (job.kind !== 'keep_going') {
			const soonest = now.getTime() + LATE_FIRE_MS;
			const at = Math.max(new Date(job.at).getTime(), soonest);
			next = {...job, at: new Date(at).toISOString(), arm: job.arm + 1};
			await store.save(next);
		}

		timers.create(next, timerWhen(next));
		rearmed.push(next);
	}

	return rearmed;
}

export function timerWhen(job: Job): TimerWhen {
	return job.kind === 'keep_going'
		? {everySeconds: job.everySeconds}
		: {at: new Date(job.at)};
}
