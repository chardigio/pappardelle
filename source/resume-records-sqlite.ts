// Resume records as rows, one set per resumable pane.

import {createHash} from 'node:crypto';
import type {PaneWidth} from './layout-sizing.ts';
import {parsePaneWidth} from './layout-sizing.ts';
import type {SplitDirection} from './companion-splits.ts';
import {createLogger} from './logger.ts';
import {
	parseResumePaneId,
	resumePaneId,
	type ResumePane,
	type ResumeRecord,
	type ResumeState,
} from './program-resume.ts';
import {GuardedReads, type StateDb} from './state-db.ts';

const log = createLogger('resume-records');

/** Where a split sits, so one opened with `companion run` can come back. */
export type SplitArrangement = {
	split: SplitDirection;
	size: PaneWidth | null;
	order: number;
};

export type SplitWithRecords = {name: string; arrangement: SplitArrangement};

export interface ResumeRecordDao {
	read(key: string, pane: ResumePane): ResumeState;
	/**
	 * Replace the pane's records, only while `token` is its current one: a
	 * closed space or a newer launch stops an old monitor writing. Resolves
	 * whether it wrote.
	 */
	save(
		key: string,
		pane: ResumePane,
		token: string,
		state: ResumeState,
	): Promise<boolean>;
	/** A new launch: its records are gone and the token hashed to `hash` is the current one. */
	commitLaunch(
		key: string,
		pane: ResumePane,
		hash: string,
		arrangement?: SplitArrangement,
	): Promise<void>;
	setArrangement(
		key: string,
		pane: ResumePane,
		arrangement: SplitArrangement,
	): Promise<void>;
	splitsWithRecords(key: string): SplitWithRecords[];
	/** Delete one pane's rows, or every pane's of the space. */
	remove(key: string, pane?: ResumePane): Promise<void>;
}

export function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

type RecordRow = {
	pid: number;
	started: string;
	uid: number;
	depth: number;
	time: number;
	argv: string;
	cwd: string | null;
	cwd_source: 'report' | 'process';
};

function toRecord(row: RecordRow): ResumeRecord {
	return {
		pid: row.pid,
		started: row.started,
		uid: row.uid,
		depth: row.depth,
		time: row.time,
		argv: JSON.parse(row.argv) as string[],
		...(row.cwd === null ? {} : {cwd: row.cwd}),
		cwdSource: row.cwd_source,
	};
}

export class SqliteResumeRecordDao implements ResumeRecordDao {
	private readonly reads = new GuardedReads(log, 'resume records');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
	) {}

	read(key: string, pane: ResumePane): ResumeState {
		return this.reads.or({records: [], times: {}}, () => {
			const {db} = this.openDb();
			const id = resumePaneId(pane);
			const records = db
				.query<RecordRow, [string, string, string]>(
					`SELECT pid, started, uid, depth, time, argv, cwd, cwd_source
					FROM resume_records WHERE repo = ? AND key = ? AND pane = ? ORDER BY time, pid`,
				)
				.all(this.repo, key, id)
				.map(row => toRecord(row));
			const times = Object.fromEntries(
				db
					.query<{pid: number; time: number}, [string, string, string]>(
						'SELECT pid, time FROM resume_times WHERE repo = ? AND key = ? AND pane = ?',
					)
					.all(this.repo, key, id)
					.map(row => [row.pid, row.time]),
			);
			return {records, times};
		});
	}

	async save(
		key: string,
		pane: ResumePane,
		token: string,
		state: ResumeState,
	): Promise<boolean> {
		const id = resumePaneId(pane);
		return this.openDb().write(() => {
			const {db} = this.openDb();
			const current = db
				.query<
					{token_hash: string},
					[string, string, string]
				>('SELECT token_hash FROM resume_panes WHERE repo = ? AND key = ? AND pane = ?')
				.get(this.repo, key, id);
			if (current?.token_hash !== tokenHash(token)) return false;
			const args = [this.repo, key, id] as const;
			db.query(
				'DELETE FROM resume_records WHERE repo = ? AND key = ? AND pane = ?',
			).run(...args);
			db.query(
				'DELETE FROM resume_times WHERE repo = ? AND key = ? AND pane = ?',
			).run(...args);
			const insertRecord = db.query(
				`INSERT INTO resume_records
				(repo, key, pane, pid, started, uid, depth, time, argv, cwd, cwd_source)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const record of state.records)
				insertRecord.run(
					...args,
					record.pid,
					record.started,
					record.uid,
					record.depth,
					record.time,
					JSON.stringify(record.argv),
					record.cwd ?? null,
					record.cwdSource,
				);
			const insertTime = db.query(
				'INSERT INTO resume_times (repo, key, pane, pid, time) VALUES (?, ?, ?, ?, ?)',
			);
			for (const [pid, time] of Object.entries(state.times))
				insertTime.run(...args, Number(pid), time);
			return true;
		});
	}

	async commitLaunch(
		key: string,
		pane: ResumePane,
		hash: string,
		arrangement?: SplitArrangement,
	): Promise<void> {
		const id = resumePaneId(pane);
		await this.openDb().write(() => {
			const {db} = this.openDb();
			db.query(
				'DELETE FROM resume_panes WHERE repo = ? AND key = ? AND pane = ?',
			).run(this.repo, key, id);
			db.query(
				`INSERT INTO resume_panes (repo, key, pane, token_hash, split, size, split_order)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				this.repo,
				key,
				id,
				hash,
				arrangement?.split ?? null,
				arrangement?.size === undefined || arrangement.size === null
					? null
					: String(arrangement.size),
				arrangement?.order ?? null,
			);
		});
	}

	async setArrangement(
		key: string,
		pane: ResumePane,
		arrangement: SplitArrangement,
	): Promise<void> {
		await this.openDb().write(() => {
			this.openDb()
				.db.query(
					`UPDATE resume_panes SET split = ?, size = ?, split_order = ?
					WHERE repo = ? AND key = ? AND pane = ?`,
				)
				.run(
					arrangement.split,
					arrangement.size === null ? null : String(arrangement.size),
					arrangement.order,
					this.repo,
					key,
					resumePaneId(pane),
				);
		});
	}

	splitsWithRecords(key: string): SplitWithRecords[] {
		return this.reads.or([], () =>
			this.openDb()
				.db.query<
					{
						pane: string;
						split: SplitDirection;
						size: string | null;
						split_order: number;
					},
					[string, string]
				>(
					`SELECT pane, split, size, split_order FROM resume_panes p
					WHERE repo = ? AND key = ? AND split IS NOT NULL AND EXISTS (
						SELECT 1 FROM resume_records r
						WHERE r.repo = p.repo AND r.key = p.key AND r.pane = p.pane
					) ORDER BY split_order, pane`,
				)
				.all(this.repo, key)
				.flatMap(row => {
					const pane = parseResumePaneId(row.pane);
					if (pane?.kind !== 'split') return [];
					return [
						{
							name: pane.name,
							arrangement: {
								split: row.split,
								size: row.size === null ? null : parsePaneWidth(row.size),
								order: row.split_order,
							},
						},
					];
				}),
		);
	}

	async remove(key: string, pane?: ResumePane): Promise<void> {
		await this.openDb().write(() => {
			const {db} = this.openDb();
			if (pane)
				db.query(
					'DELETE FROM resume_panes WHERE repo = ? AND key = ? AND pane = ?',
				).run(this.repo, key, resumePaneId(pane));
			else
				db.query('DELETE FROM resume_panes WHERE repo = ? AND key = ?').run(
					this.repo,
					key,
				);
		});
	}
}
