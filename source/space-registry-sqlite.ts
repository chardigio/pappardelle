// The space registry as rows.
//
// A space is `starting` from the moment idow knows its key until its
// sessions exist, and `closing` from before its sessions are killed until its
// row is gone. Neither is listed as open, and both keep the reaper away, so a
// write that fails partway never leaves live sessions that belong to nothing.
//
// Watchlist reservations are rows too, changed in the same transaction as the
// spaces they are counted against.

import {isPidAlive as defaultIsPidAlive} from './file-lock.ts';
import {
	reserveWatchlistSlots,
	type ProtectedSpaces,
	type SettleDeps,
	type SpacePhase,
	type SpacePhaseLookup,
	type SpaceRegistryDao,
	type WatchlistReservation,
	type WatchlistSlots,
} from './space-registry.ts';
import type {SpaceIdentity, SpaceIdentityDao} from './space-identity.ts';
import type {StateDb} from './state-db.ts';

type SpaceRow = {key: string; state: SpacePhase; owner_pid: number | null};

type ReservationRow = {key: string; source: string; owner_pid: number};

export class SqliteSpaceRegistryDao implements SpaceRegistryDao {
	/**
	 * `openDb` is called on each use, so a database that cannot be opened is a
	 * failed read (which the reaper respects) and not a failed startup.
	 */
	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly identities: Pick<SpaceIdentityDao, 'get'>,
		private readonly pid = process.pid,
		private readonly isPidAlive = defaultIsPidAlive,
	) {}

	openSpaces(): string[] {
		return this.keysIn('open');
	}

	protectedSpaces(): ProtectedSpaces {
		try {
			return {ok: true, keys: this.rows().map(row => row.key)};
		} catch (error) {
			return {ok: false, error};
		}
	}

	has(key: string): boolean {
		try {
			return this.row(key) !== null;
		} catch {
			// Callers clean up after spaces that are gone. One that cannot be
			// looked up has to be assumed still there.
			return true;
		}
	}

	phase(key: string): SpacePhaseLookup {
		try {
			const row = this.row(key);
			return row ? {kind: 'phase', phase: row.state} : {kind: 'unknown'};
		} catch (error) {
			return {kind: 'unreadable', error};
		}
	}

	async add(key: string): Promise<void> {
		await this.openDb().write(() => {
			this.setOpen(key);
		});
	}

	async remove(key: string): Promise<void> {
		await this.openDb().write(() => {
			this.delete(key);
			this.dropReservation(key);
		});
	}

	async reserveStart(key: string, ownerPid: number): Promise<void> {
		await this.openDb().write(() => {
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
		await this.openDb().write(() => {
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
		const live = deps.liveSessions();
		if (!live) return;
		const names = new Map<string, SpaceIdentity>();
		for (const row of unsettled()) {
			const lookup = this.identities.get(row.key);
			// Without its names a space's sessions can't be told apart from
			// none, and dropping its row would hand them to the reaper.
			if (lookup.kind !== 'identity') return;
			names.set(row.key, lookup.identity);
		}

		const running = (key: string) => {
			const identity = names.get(key);
			return (
				identity !== undefined &&
				(live.has(identity.tmux.agentSession) ||
					live.has(identity.tmux.companionSession))
			);
		};
		await this.openDb().write(() => {
			for (const row of unsettled()) {
				// What the owner meant to do no longer matters; what exists does.
				if (running(row.key)) {
					this.setOpen(row.key);
				} else {
					this.delete(row.key);
					this.dropReservation(row.key);
				}
			}
		});
	}

	async tryReserveWatchlistSlots(
		source: string,
		candidateKeys: string[],
		max: number,
	): Promise<WatchlistSlots> {
		return this.openDb().write(() => {
			const reservations = this.reservations();
			const {slots, changed} = reserveWatchlistSlots(
				reservations,
				new Set(this.rows().map(row => row.key)),
				source,
				candidateKeys,
				max,
				this.pid,
				this.isPidAlive,
			);
			if (changed) this.replaceReservations(reservations);
			return slots;
		});
	}

	async releaseWatchlistReservation(key: string): Promise<void> {
		await this.openDb().write(() => {
			if (this.row(key)?.state === 'open') return;
			this.dropReservation(key);
		});
	}

	private reservations(): Map<string, WatchlistReservation> {
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

	private dropReservation(key: string): void {
		this.openDb()
			.db.query('DELETE FROM watchlist_reservations WHERE repo = ? AND key = ?')
			.run(this.repo, key);
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

	private keysIn(state: SpacePhase): string[] {
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
	 * Make the open rows match `keys`, for a caller inside a write
	 * transaction. Spaces being set up or torn down are left alone.
	 */
	replaceOpen(keys: readonly string[]): void {
		const listed = new Set(keys);
		for (const key of this.keysIn('open')) {
			if (!listed.has(key)) this.delete(key);
		}

		for (const key of keys) this.setOpen(key);
	}

	/** Replace every reservation, for a caller inside a write transaction. */
	replaceReservations(
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
