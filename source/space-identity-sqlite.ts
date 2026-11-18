// Space identities as rows. A row outlives its space, so a key opened again
// keeps its names, and a closed space can still be named.

import {
	defaultIdentity,
	identityAt,
	type IdentityDefaults,
	type SpaceIdentity,
	type SpaceIdentityDao,
	type SpaceIdentityList,
	type SpaceIdentityLookup,
} from './space-identity.ts';
import type {JsonMirror, StateDb} from './state-db.ts';

type IdentityRow = {
	key: string;
	worktree_path: string;
	tmux_socket: string;
	agent_session: string;
	companion_session: string;
};

const COLUMNS =
	'key, worktree_path, tmux_socket, agent_session, companion_session';

export class SqliteSpaceIdentityDao implements SpaceIdentityDao {
	/**
	 * `registryMirror` is the registry file: a space opened without the
	 * database is given its identity when that file is imported, so it is
	 * imported before identities are read.
	 */
	constructor(
		private readonly openDb: () => StateDb,
		private readonly defaults: IdentityDefaults,
		private readonly registryMirror: () => JsonMirror,
	) {}

	get(key: string): SpaceIdentityLookup {
		try {
			const row = this.synced()
				.db.query<
					IdentityRow,
					[string, string]
				>(`SELECT ${COLUMNS} FROM space_identities WHERE repo = ? AND key = ?`)
				.get(this.defaults.repo, key);
			return row
				? {kind: 'identity', identity: this.identity(row)}
				: {kind: 'unknown'};
		} catch (error) {
			return {kind: 'unreadable', error};
		}
	}

	list(): SpaceIdentityList {
		try {
			return {kind: 'identities', identities: this.rows()};
		} catch (error) {
			return {kind: 'unreadable', error};
		}
	}

	atPath(at: string): SpaceIdentityLookup {
		const listed = this.list();
		if (listed.kind === 'unreadable') return listed;
		const identity = identityAt(at, listed.identities);
		return identity ? {kind: 'identity', identity} : {kind: 'unknown'};
	}

	async record(identity: SpaceIdentity): Promise<void> {
		await this.openDb().writeRows(() => {
			this.openDb()
				.db.query(
					`INSERT INTO space_identities (repo, ${COLUMNS})
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT (repo, key) DO NOTHING`,
				)
				.run(...this.values(identity));
		});
	}

	/**
	 * Give keys opened without the database the identity idow gave them, inside
	 * the transaction that imports them. A key that already has one keeps it.
	 */
	fillMissing(keys: readonly string[]): void {
		const insert = this.openDb().db.query(
			`INSERT OR IGNORE INTO space_identities (repo, ${COLUMNS})
			VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const key of keys)
			insert.run(...this.values(defaultIdentity(this.defaults, key)));
	}

	private synced(): StateDb {
		const state = this.openDb();
		// A registry file that cannot be imported now leaves the rows as they
		// are, and those are still the identities that were recorded.
		state.sync(this.registryMirror());
		return state;
	}

	private rows(): SpaceIdentity[] {
		return this.synced()
			.db.query<IdentityRow, [string]>(
				`SELECT ${COLUMNS} FROM space_identities WHERE repo = ? ORDER BY rowid`,
			)
			.all(this.defaults.repo)
			.map(row => this.identity(row));
	}

	private identity(row: IdentityRow): SpaceIdentity {
		return {
			repo: this.defaults.repo,
			key: row.key,
			worktreePath: row.worktree_path,
			tmux: {
				socket: row.tmux_socket,
				agentSession: row.agent_session,
				companionSession: row.companion_session,
			},
		};
	}

	private values(
		identity: SpaceIdentity,
	): [string, string, string, string, string, string] {
		return [
			identity.repo,
			identity.key,
			identity.worktreePath,
			identity.tmux.socket,
			identity.tmux.agentSession,
			identity.tmux.companionSession,
		];
	}
}
