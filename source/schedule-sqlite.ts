// Scheduled jobs and queued messages as rows.

import {isDeepStrictEqual} from 'node:util';
import {createLogger} from './logger.ts';
import type {Job, ScheduleDao, SendOutcome} from './schedule.ts';
import {GuardedReads, type StateDb} from './state-db.ts';

const log = createLogger('schedule');

type JobRow = {
	id: string;
	kind: Job['kind'];
	key: string;
	at: string | null;
	message: string | null;
	arm: number | null;
	defer_reason: string | null;
	defer_count: number | null;
	every_seconds: number | null;
	nudge: string | null;
	until: string | null;
	idle_checks: number | null;
};

const JOB_COLUMNS =
	'id, kind, key, at, message, arm, defer_reason, defer_count, every_seconds, nudge, until, idle_checks';

function toJob(row: JobRow): Job {
	const {id, key} = row;
	if (row.kind === 'keep_going') {
		return {
			kind: row.kind,
			id,
			key,
			everySeconds: row.every_seconds!,
			nudge: row.nudge!,
			until: row.until,
			idleChecks: row.idle_checks!,
		};
	}

	return {
		kind: row.kind,
		id,
		key,
		at: row.at!,
		message: row.message!,
		arm: row.arm!,
		...(row.defer_reason ? {deferReason: row.defer_reason as SendOutcome} : {}),
		...(row.defer_count ? {deferCount: row.defer_count} : {}),
	};
}

export class SqliteScheduleDao implements ScheduleDao {
	private readonly reads = new GuardedReads(log, 'scheduled jobs');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
	) {}

	async save(job: Job): Promise<void> {
		await this.openDb().write(() => {
			if (isDeepStrictEqual(this.row(job.id), job)) return;
			this.put(job);
		});
	}

	load(id: string): Job | null {
		return this.reads.or(null, () => this.row(id));
	}

	list(): Job[] {
		return this.reads.or([], () => {
			return this.openDb()
				.db.query<JobRow, [string]>(
					`SELECT ${JOB_COLUMNS} FROM schedules WHERE repo = ? ORDER BY id`,
				)
				.all(this.repo)
				.map(row => toJob(row));
		});
	}

	async delete(id: string): Promise<void> {
		await this.openDb().write(() => {
			this.deleteRow(id);
		});
	}

	async queue(key: string, text: string): Promise<void> {
		await this.openDb().write(() => {
			this.putQueued(key, text);
		});
	}

	queued(key: string): string | null {
		return this.reads.or(null, () => {
			return (
				this.openDb()
					.db.query<
						{text: string},
						[string, string]
					>('SELECT text FROM queued_messages WHERE repo = ? AND key = ?')
					.get(this.repo, key)?.text ?? null
			);
		});
	}

	async clearQueued(key: string): Promise<void> {
		await this.openDb().write(() => {
			this.deleteQueued(key);
		});
	}

	private row(id: string): Job | null {
		const row = this.openDb()
			.db.query<
				JobRow,
				[string, string]
			>(`SELECT ${JOB_COLUMNS} FROM schedules WHERE repo = ? AND id = ?`)
			.get(this.repo, id);
		return row ? toJob(row) : null;
	}

	/** For a caller inside a write transaction. */
	put(job: Job): void {
		const oneShot = job.kind === 'keep_going' ? null : job;
		const keepGoing = job.kind === 'keep_going' ? job : null;
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO schedules (repo, ${JOB_COLUMNS})
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.repo,
				job.id,
				job.kind,
				job.key,
				oneShot?.at ?? null,
				oneShot?.message ?? null,
				oneShot?.arm ?? null,
				oneShot?.deferReason ?? null,
				oneShot?.deferCount ?? null,
				keepGoing?.everySeconds ?? null,
				keepGoing?.nudge ?? null,
				keepGoing?.until ?? null,
				keepGoing?.idleChecks ?? null,
			);
	}

	/** For a caller inside a write transaction. */
	deleteRow(id: string): void {
		this.openDb()
			.db.query('DELETE FROM schedules WHERE repo = ? AND id = ?')
			.run(this.repo, id);
	}

	/** For a caller inside a write transaction. */
	putQueued(key: string, text: string): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO queued_messages (repo, key, text)
				VALUES (?, ?, ?)`,
			)
			.run(this.repo, key, text);
	}

	/** For a caller inside a write transaction. */
	deleteQueued(key: string): void {
		this.openDb()
			.db.query('DELETE FROM queued_messages WHERE repo = ? AND key = ?')
			.run(this.repo, key);
	}
}
