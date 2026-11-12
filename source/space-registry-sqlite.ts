// The space registry as rows, with the JSON file kept beside them.
//
// A space is `starting` from the moment idow knows its key until its
// sessions exist, and `closing` from before its sessions are killed until its
// row is gone. Neither is listed as open, and both keep the reaper away, so a
// write that fails partway never leaves live sessions that belong to nothing.
//
// Watchlist reservations are rows too, changed in the same transaction as the
// spaces they are counted against, with their sidecar file kept beside them.

import fs from 'node:fs';
import {isPidAlive as defaultIsPidAlive} from './file-lock.ts';
import {
	parseRegistry,
	parseWatchlistReservations,
	renderRegistry,
	renderWatchlistReservations,
	reserveWatchlistSlots,
	type JsonSpaceRegistryDao,
	type ProtectedSpaces,
	type SettleDeps,
	type SpaceRegistryDao,
	type WatchlistReservation,
	type WatchlistReserveOptions,
	type WatchlistSlots,
} from './space-registry.ts';
import {
	retryBusy,
	type JsonMirror,
	type StateDb,
	type WriteTx,
} from './state-db.ts';

type SpaceState = 'starting' | 'open' | 'closing';

type SpaceRow = {key: string; state: SpaceState; owner_pid: number | null};

type ReservationRow = {key: string; source: string; owner_pid: number};

export class SqliteSpaceRegistryDao implements SpaceRegistryDao {
	get keepsLifecycle(): boolean {
		return true;
	}

	private readonly mirror: JsonMirror;
	private readonly reservationMirror: JsonMirror;

	/**
	 * `openDb` is called on each use, so a database that cannot be opened is a
	 * failed read (which the reaper respects) and not a failed startup.
	 */
	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly json: JsonSpaceRegistryDao,
		private readonly pid = process.pid,
		private readonly isPidAlive = defaultIsPidAlive,
	) {
		this.mirror = {
			file: json.file,
			importRows: content => {
				// A registry file that is gone says nothing about the rows.
				if (content !== null) this.replaceOpen(parseRegistry(content));
			},
		};
		this.reservationMirror = {
			file: json.reservations.file,
			importRows: content => {
				// A sidecar that is gone says nothing about the rows either.
				if (content !== null)
					this.replaceReservations(parseWatchlistReservations(content));
			},
		};
	}

	openSpaces(): string[] | null {
		this.openDb().sync(this.mirror);
		const rows = this.rows();
		// The same answer the file gives a process without the database.
		if (rows.length === 0 && !fs.existsSync(this.json.file)) return null;
		return rows.filter(row => row.state === 'open').map(row => row.key);
	}

	async openSpacesAsync(): Promise<string[] | null> {
		return this.openSpaces();
	}

	protectedSpaces(): ProtectedSpaces {
		try {
			const synced = this.openDb().sync(this.mirror);
			// Rows that may be behind the file could leave out a space another
			// process just opened.
			if (synced === 'malformed' || synced === 'busy')
				return {
					ok: false,
					error: new Error(
						`${this.json.file} could not be imported (${synced})`,
					),
				};
			return {ok: true, keys: this.rows().map(row => row.key)};
		} catch (error) {
			return {ok: false, error};
		}
	}

	has(key: string): boolean {
		try {
			this.openDb().sync(this.mirror);
			return this.row(key) !== null;
		} catch {
			// Callers clean up after spaces that are gone. One that cannot be
			// looked up has to be assumed still there.
			return true;
		}
	}

	async add(key: string, signal?: AbortSignal): Promise<void> {
		await this.change(() => {
			this.setOpen(key);
		}, signal);
	}

	async remove(key: string, signal?: AbortSignal): Promise<void> {
		await this.change(tx => {
			this.delete(key);
			this.dropReservation(tx, key);
		}, signal);
	}

	async reserveStart(key: string, ownerPid: number): Promise<void> {
		await this.change(() => {
			this.openDb()
				.db.query(
					`INSERT INTO spaces (repo, key, state, owner_pid)
					VALUES (?, ?, 'starting', ?)
					ON CONFLICT (repo, key) DO NOTHING`,
				)
				.run(this.repo, key, ownerPid);
		});
	}

	async markClosing(key: string): Promise<void> {
		await this.change(() => {
			this.openDb()
				.db.query(
					`UPDATE spaces SET state = 'closing', owner_pid = ?
					WHERE repo = ? AND key = ? AND state = 'open'`,
				)
				.run(this.pid, this.repo, key);
		});
	}

	async reopen(key: string): Promise<void> {
		await this.add(key);
	}

	async settle(deps: SettleDeps): Promise<void> {
		const unsettled = () =>
			this.rows().filter(row => {
				if (row.state === 'open') return false;
				if (row.owner_pid === this.pid) {
					// This process's own close whose removal failed.
					return row.state === 'closing' && !deps.closing.has(row.key);
				}

				return row.owner_pid === null || !this.isPidAlive(row.owner_pid);
			});
		if (unsettled().length === 0) return;
		const live = deps.liveSessionKeys();
		if (!live) return;
		await this.change(() => {
			for (const row of unsettled()) {
				// What the owner meant to do no longer matters; what exists does.
				if (live.has(row.key)) this.setOpen(row.key);
				else this.delete(row.key);
			}
		});
	}

	async tryReserveWatchlistSlots(
		source: string,
		candidateKeys: string[],
		max: number,
		options: WatchlistReserveOptions = {},
	): Promise<WatchlistSlots> {
		return this.change(tx => {
			const reservations = this.reservations(tx);
			const {slots, changed} = reserveWatchlistSlots(
				reservations,
				new Set(this.rows().map(row => row.key)),
				source,
				candidateKeys,
				max,
				options,
			);
			if (changed) this.storeReservations(tx, reservations);
			return slots;
		}, options.signal);
	}

	async releaseWatchlistReservation(key: string): Promise<void> {
		await this.change(tx => {
			if (this.row(key)?.state === 'open') return;
			this.dropReservation(tx, key);
		});
	}

	/**
	 * Change rows and rewrite the file from them. The file's own lock is
	 * taken as well: a process running without the database still relies on
	 * it, and holding both keeps the two kinds of writer from interleaving.
	 */
	private async change<T>(
		body: (tx: WriteTx) => T,
		signal?: AbortSignal,
	): Promise<T> {
		return retryBusy(async () =>
			this.json.locked(
				() =>
					this.openDb().tryWrite(tx => {
						// A registry file that cannot be read may list spaces these
						// rows have never seen. Rewriting it from them would drop
						// those spaces for every process still reading the file.
						if (tx.sync(this.mirror) === 'malformed')
							throw new Error('Invalid workspace registry');
						const before = this.keysIn('open');
						const result = body(tx);
						const after = this.keysIn('open');
						if (before.join('\n') !== after.join('\n'))
							tx.mirror(this.json.file, renderRegistry(after));
						return result;
					}),
				signal,
			),
		);
	}

	/** The reservations to change, inside `change`. */
	private reservations(tx: WriteTx): Map<string, WatchlistReservation> {
		tx.sync(this.reservationMirror);
		return new Map(
			this.openDb()
				.db.query<ReservationRow, [string]>(
					`SELECT key, source, owner_pid FROM watchlist_reservations
					WHERE repo = ? ORDER BY rowid`,
				)
				.all(this.repo)
				.map(row => [row.key, {source: row.source, ownerPid: row.owner_pid}]),
		);
	}

	private storeReservations(
		tx: WriteTx,
		reservations: ReadonlyMap<string, WatchlistReservation>,
	): void {
		this.replaceReservations(reservations);
		tx.mirror(
			this.reservationMirror.file,
			renderWatchlistReservations(reservations),
		);
	}

	private dropReservation(tx: WriteTx, key: string): void {
		const reservations = this.reservations(tx);
		if (reservations.delete(key)) this.storeReservations(tx, reservations);
	}

	private rows(): SpaceRow[] {
		return this.openDb()
			.db.query<
				SpaceRow,
				[string]
			>('SELECT key, state, owner_pid FROM spaces WHERE repo = ? ORDER BY rowid')
			.all(this.repo);
	}

	private row(key: string): SpaceRow | null {
		return this.openDb()
			.db.query<
				SpaceRow,
				[string, string]
			>('SELECT key, state, owner_pid FROM spaces WHERE repo = ? AND key = ?')
			.get(this.repo, key);
	}

	private keysIn(state: SpaceState): string[] {
		return this.rows()
			.filter(row => row.state === state)
			.map(row => row.key);
	}

	private setOpen(key: string): void {
		this.openDb()
			.db.query(
				`INSERT INTO spaces (repo, key, state, owner_pid)
				VALUES (?, ?, 'open', NULL)
				ON CONFLICT (repo, key) DO UPDATE SET state = 'open', owner_pid = NULL
				WHERE state != 'open'`,
			)
			.run(this.repo, key);
	}

	private delete(key: string): void {
		this.openDb()
			.db.query('DELETE FROM spaces WHERE repo = ? AND key = ?')
			.run(this.repo, key);
	}

	/**
	 * Make the open rows match a file written without the database. Spaces
	 * being set up or torn down are not in the file, so its silence about
	 * them means nothing.
	 */
	private replaceOpen(keys: string[]): void {
		const listed = new Set(keys);
		for (const key of this.keysIn('open')) {
			if (!listed.has(key)) this.delete(key);
		}

		for (const key of keys) this.setOpen(key);
	}

	private replaceReservations(
		reservations: ReadonlyMap<string, WatchlistReservation>,
	): void {
		const {db} = this.openDb();
		db.query('DELETE FROM watchlist_reservations WHERE repo = ?').run(
			this.repo,
		);
		const insert = db.query(
			`INSERT INTO watchlist_reservations (repo, key, source, owner_pid)
			VALUES (?, ?, ?, ?)`,
		);
		for (const [key, entry] of reservations)
			insert.run(this.repo, key, entry.source, entry.ownerPid);
	}
}
