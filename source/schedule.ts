// Wake-ups for a supervised space: a message at a set time, `continue` once a
// Codex usage limit resets, or a job that keeps an agent working by nudging it
// when it sits idle. Jobs live in ~/.pappardelle/repos/{repo}/schedules/, and
// an OS user timer runs `pappardelle schedule fire ID` for each.

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
import {DEFAULT_REPO_STATE_ROOT} from './tui-marker.ts';

export type Job =
	| {kind: 'at'; id: string; key: string; at: string; message: string}
	| {kind: 'after_limit'; id: string; key: string; at: string; message: string}
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
	| 'skipped_working'
	| 'skipped_draft'
	| 'expired';

export type SendOutcome =
	| 'sent'
	| 'draft'
	| 'prompt'
	| 'no-session'
	| 'busy'
	| 'failed';

// Codex can refuse a message sent the second its limit resets.
export const RESET_MARGIN_MS = 60_000;
// The idle check after which keep_going nudges, as 3wf.sh did: one idle
// check can catch an agent between two turns.
const IDLE_CHECKS_BEFORE_NUDGE = 2;

export type ScheduleStore = {
	root: string;
	repo: string;
};

export function defaultScheduleStore(repo: string): ScheduleStore {
	return {root: DEFAULT_REPO_STATE_ROOT, repo};
}

const jobsDir = (store: ScheduleStore) =>
	path.join(store.root, store.repo, 'schedules');
const queueFile = (store: ScheduleStore, key: string) =>
	path.join(store.root, store.repo, 'queued', `${encodeURIComponent(key)}.txt`);

export function newJobId(): string {
	return randomUUID().slice(0, 8);
}

export function saveJob(store: ScheduleStore, job: Job): void {
	mkdirSync(jobsDir(store), {recursive: true});
	const file = path.join(jobsDir(store), `${job.id}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify(job, null, '\t') + '\n');
	// Renamed into place, so a timer firing mid-write never reads half a job.
	renameSync(`${file}.tmp`, file);
}

export function loadJob(store: ScheduleStore, id: string): Job | null {
	try {
		return JSON.parse(
			readFileSync(path.join(jobsDir(store), `${id}.json`), 'utf8'),
		) as Job;
	} catch {
		return null;
	}
}

export function listJobs(store: ScheduleStore): Job[] {
	let files: string[];
	try {
		files = readdirSync(jobsDir(store));
	} catch {
		return [];
	}

	return files
		.filter(file => file.endsWith('.json'))
		.map(file => loadJob(store, file.slice(0, -5)))
		.filter((job): job is Job => job !== null);
}

export function deleteJob(store: ScheduleStore, id: string): void {
	rmSync(path.join(jobsDir(store), `${id}.json`), {force: true});
}

export function queueMessage(
	store: ScheduleStore,
	key: string,
	text: string,
): void {
	mkdirSync(path.dirname(queueFile(store, key)), {recursive: true});
	writeFileSync(queueFile(store, key), text);
}

export function queuedMessage(
	store: ScheduleStore,
	key: string,
): string | null {
	try {
		return readFileSync(queueFile(store, key), 'utf8');
	} catch {
		return null;
	}
}

function clearQueuedMessage(store: ScheduleStore, key: string): void {
	rmSync(queueFile(store, key), {force: true});
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
	store: ScheduleStore;
	now: Date;
	readState: (key: string) => Promise<AgentStateReport>;
	send: (key: string, text: string) => Promise<SendOutcome>;
	createTimer: (job: Job) => void;
	/** Removes the job's timer once the job is done. */
	removeTimer: (job: Job) => void;
};

async function sendNext(
	job: Job,
	text: string,
	deps: FireDeps,
): Promise<FireResult> {
	const queued = queuedMessage(deps.store, job.key);
	const outcome = await deps.send(job.key, queued ?? text);
	if (outcome === 'draft') return 'skipped_draft';
	if (outcome !== 'sent') return 'waiting';
	// Only once it's out, so a refused send keeps it for the next try.
	if (queued !== null) clearQueuedMessage(deps.store, job.key);
	return 'sent';
}

function finish(job: Job, deps: FireDeps): void {
	deleteJob(deps.store, job.id);
	deps.removeTimer(job);
}

export async function fireJob(job: Job, deps: FireDeps): Promise<FireResult> {
	const {now} = deps;
	if (job.kind === 'at') {
		const result = await sendNext(job, job.message, deps);
		finish(job, deps);
		return result;
	}

	if (job.kind === 'after_limit') {
		const report = await deps.readState(job.key);
		const lifts = limitLiftsAt(report);
		if (report.state === 'usage_limit' && lifts && lifts > now) {
			// The limit now resets later than first shown. A new id, since the
			// running timer's unit still holds this one's name.
			const later: Job = {...job, id: newJobId(), at: lifts.toISOString()};
			saveJob(deps.store, later);
			deps.createTimer(later);
			deleteJob(deps.store, job.id);
			return 'waiting';
		}

		// Codex keeps the limit message on screen after the reset until
		// something is sent, so a passed reset sends even though it's showing.
		const result = await sendNext(job, job.message, deps);
		finish(job, deps);
		return result;
	}

	if (job.until && new Date(job.until) <= now) {
		finish(job, deps);
		return 'expired';
	}

	const report = await deps.readState(job.key);
	const save = (idleChecks: number) =>
		saveJob(deps.store, {...job, idleChecks});
	switch (report.state) {
		case 'working': {
			save(0);
			return 'skipped_working';
		}

		case 'draft': {
			return 'skipped_draft';
		}

		case 'usage_limit': {
			const lifts = limitLiftsAt(report);
			if (!lifts || lifts > now) return 'waiting';
			save(0);
			return sendNext(job, 'continue', deps);
		}

		case 'idle': {
			const idleChecks = job.idleChecks + 1;
			if (idleChecks < IDLE_CHECKS_BEFORE_NUDGE) {
				save(idleChecks);
				return 'waiting';
			}

			save(0);
			return sendNext(job, job.nudge, deps);
		}

		case 'permission':
		case 'question':
		case 'auth':
		case 'no_session': {
			// The supervising agent's to answer.
			save(0);
			return 'waiting';
		}
	}
}

export function timerWhen(job: Job): TimerWhen {
	return job.kind === 'keep_going'
		? {everySeconds: job.everySeconds}
		: {at: new Date(job.at)};
}
