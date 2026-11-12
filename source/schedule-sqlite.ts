// Scheduled jobs and queued messages as rows, with each one's file kept
// beside it.
//
// A timer service fires a job from a process of its own, which may be an
// older binary or one started without the flag, so every read looks at the
// job's file first and takes the file's word when it changed.

import {isDeepStrictEqual} from 'node:util';
import {createLogger} from './logger.ts';
import {
	parseJob,
	renderJob,
	type Job,
	type JsonScheduleDao,
	type ScheduleDao,
} from './schedule.ts';
import {GuardedReads, type JsonMirror, type StateDb} from './state-db.ts';

const log = createLogger('schedule');

type JobRow = {
	id: string;
	kind: Job['kind'];
	key: string;
	at: string | null;
	message: string | null;
	arm: number | null;
	every_seconds: number | null;
	nudge: string | null;
	until: string | null;
	idle_checks: number | null;
};

const JOB_COLUMNS =
	'id, kind, key, at, message, arm, every_seconds, nudge, until, idle_checks';

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
	};
}

export class SqliteScheduleDao implements ScheduleDao {
	private readonly reads = new GuardedReads(log, 'scheduled jobs');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly json: JsonScheduleDao,
	) {}

	async save(job: Job): Promise<void> {
		const mirror = this.jobMirror(job.id);
		await this.openDb().write(tx => {
			tx.sync(mirror);
			if (isDeepStrictEqual(this.row(job.id), job)) return;
			this.put(job);
			tx.mirror(mirror.file, renderJob(job));
		});
	}

	load(id: string): Job | null {
		return this.reads.or(null, () => {
			this.openDb().sync(this.jobMirror(id));
			return this.row(id);
		});
	}

	list(): Job[] {
		return this.reads.or([], () => {
			// A process without the database leaves a job file with no row yet,
			// and removes one without touching its row.
			for (const id of new Set([...this.json.ids(), ...this.storedIds()]))
				this.openDb().sync(this.jobMirror(id));
			return this.openDb()
				.db.query<JobRow, [string]>(
					`SELECT ${JOB_COLUMNS} FROM schedules WHERE repo = ? ORDER BY id`,
				)
				.all(this.repo)
				.map(row => toJob(row));
		});
	}

	async delete(id: string): Promise<void> {
		const mirror = this.jobMirror(id);
		await this.openDb().write(tx => {
			this.deleteRow(id);
			tx.mirror(mirror.file, null);
		});
	}

	async queue(key: string, text: string): Promise<void> {
		const mirror = this.queueMirror(key);
		await this.openDb().write(tx => {
			this.putQueued(key, text);
			tx.mirror(mirror.file, text);
		});
	}

	queued(key: string): string | null {
		return this.reads.or(null, () => {
			this.openDb().sync(this.queueMirror(key));
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
		const mirror = this.queueMirror(key);
		await this.openDb().write(tx => {
			this.deleteQueued(key);
			tx.mirror(mirror.file, null);
		});
	}

	private jobMirror(id: string): JsonMirror {
		return {
			file: this.json.jobFile(id),
			importRows: content => {
				// A finished or cancelled job's file is removed, so its row goes
				// with it.
				if (content === null) this.deleteRow(id);
				else this.put(parseJob(content));
			},
		};
	}

	private queueMirror(key: string): JsonMirror {
		return {
			file: this.json.queueFile(key),
			importRows: content => {
				// The file is removed once its message is sent.
				if (content === null) this.deleteQueued(key);
				else this.putQueued(key, content);
			},
		};
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

	private storedIds(): string[] {
		return this.openDb()
			.db.query<{id: string}, [string]>(
				'SELECT id FROM schedules WHERE repo = ?',
			)
			.all(this.repo)
			.map(row => row.id);
	}

	private put(job: Job): void {
		const oneShot = job.kind === 'keep_going' ? null : job;
		const keepGoing = job.kind === 'keep_going' ? job : null;
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO schedules (repo, ${JOB_COLUMNS})
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.repo,
				job.id,
				job.kind,
				job.key,
				oneShot?.at ?? null,
				oneShot?.message ?? null,
				oneShot?.arm ?? null,
				keepGoing?.everySeconds ?? null,
				keepGoing?.nudge ?? null,
				keepGoing?.until ?? null,
				keepGoing?.idleChecks ?? null,
			);
	}

	private deleteRow(id: string): void {
		this.openDb()
			.db.query('DELETE FROM schedules WHERE repo = ? AND id = ?')
			.run(this.repo, id);
	}

	private putQueued(key: string, text: string): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO queued_messages (repo, key, text)
				VALUES (?, ?, ?)`,
			)
			.run(this.repo, key, text);
	}

	private deleteQueued(key: string): void {
		this.openDb()
			.db.query('DELETE FROM queued_messages WHERE repo = ? AND key = ?')
			.run(this.repo, key);
	}
}
