// Space identities as rows. A row outlives its space, so a key opened again
// keeps its names, and a closed space can still be named.

import fs from 'node:fs';
import path from 'node:path';
import {
	defaultIdentity,
	identityAt,
	sessionNamesFor,
	type IdentityDefaults,
	type SpaceIdentity,
	type SpaceIdentityDao,
	type SpaceIdentityList,
	type SpaceIdentityLookup,
} from './space-identity.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
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
		let identities: SpaceIdentity[];
		try {
			// Closed rows are kept forever, and a closed space holds no caller.
			identities = this.synced()
				.db.query<IdentityRow, [string]>(
					`SELECT ${COLUMNS} FROM space_identities i
					WHERE i.repo = ?1 AND (i.key = 'main' OR EXISTS (
						SELECT 1 FROM spaces s WHERE s.repo = i.repo AND s.key = i.key))`,
				)
				.all(this.defaults.repo)
				.map(row => this.identity(row));
		} catch (error) {
			return {kind: 'unreadable', error};
		}

		const identity = identityAt(at, identities);
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

	async moveMain(identity: SpaceIdentity): Promise<void> {
		await this.openDb().writeRows(() => {
			this.openDb()
				.db.query(
					`INSERT INTO space_identities (repo, ${COLUMNS})
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT (repo, key) DO UPDATE SET
						worktree_path = excluded.worktree_path,
						tmux_socket = excluded.tmux_socket`,
				)
				.run(...this.values(identity));
		});
	}

	async respellFormatSessions(): Promise<void> {
		await this.openDb().writeRows(() => {
			const {db} = this.openDb();
			const keys = db
				.query<{key: string}, [string]>(
					`SELECT key FROM space_identities
					WHERE repo = ? AND (instr(agent_session, '#') > 0 OR instr(companion_session, '#') > 0)`,
				)
				.all(this.defaults.repo);
			// A name another repo's space already holds is left as it is.
			const respell = db.query(
				`UPDATE OR IGNORE space_identities SET agent_session = ?, companion_session = ?
				WHERE repo = ? AND key = ?`,
			);
			for (const {key} of keys) {
				const sessions = sessionNamesFor(key, this.defaults.repo);
				respell.run(
					sessions.agent,
					sessions.companion,
					this.defaults.repo,
					key,
				);
			}
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
		this.ensureMain(state);
		return state;
	}

	/**
	 * Seed main's identity on first read after enabling sqliteState, when this
	 * checkout belongs to the repo and has Pappardelle config or open spaces.
	 */
	private ensureMain(state: StateDb): void {
		const existing = state.db
			.query<
				{found: number},
				[string, string]
			>('SELECT 1 AS found FROM space_identities WHERE repo = ? AND key = ?')
			.get(this.defaults.repo, MAIN_WORKTREE_KEY);
		if (existing) return;

		let mainRoot: string;
		try {
			mainRoot = this.defaults.mainRoot();
		} catch {
			return;
		}

		if (path.basename(mainRoot) !== this.defaults.repo) return;
		const hasConfig = fs.existsSync(path.join(mainRoot, '.pappardelle.yml'));
		if (!hasConfig) {
			const hasSpaces = state.db
				.query<
					{found: number},
					[string]
				>('SELECT 1 AS found FROM spaces WHERE repo = ? LIMIT 1')
				.get(this.defaults.repo);
			if (!hasSpaces) return;
		}

		state.db
			.query(
				`INSERT OR IGNORE INTO space_identities (repo, ${COLUMNS})
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(...this.values(defaultIdentity(this.defaults, MAIN_WORKTREE_KEY)));
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
