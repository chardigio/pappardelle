// Per-space state as rows.
//
// Four writers share it: the rail poll, the profile backfill, link-pr and
// idow. Each changes only its own columns inside one transaction, so none can
// undo another's write, and a write that changes nothing leaves the row
// alone.

import {isDeepStrictEqual} from 'node:util';
import {createLogger} from './logger.ts';
import type {PipelineStatus} from './providers/types.ts';
import {
	type SpacePrLink,
	type SpaceState,
	type SpaceStateDao,
	type SpaceStateLookup,
	type SpaceStatePatch,
} from './space-state.ts';
import {GuardedReads, type StateDb} from './state-db.ts';

const log = createLogger('space-state');

/**
 * A space state tells "the rail has not been polled" (no pipeline) from
 * "polled, and the branch has no PR" (a null pipeline). NULL is the first and
 * this value the second.
 */
const NO_PIPELINE = 'none';

type Columns = {
	profile: string | null;
	issue_title: string | null;
	pipeline: PipelineStatus | typeof NO_PIPELINE | null;
	unresolved_comment_count: number | null;
	pr_number: number | null;
	has_conflict: 0 | 1 | null;
	recap_custom_title: string | null;
	recap_last_prompt: string | null;
	recap_last_assistant_excerpt: string | null;
	agent_profile: string | null;
	agent_is_claude: 0 | 1 | null;
};

type Row = Columns & {updated_at: string | null};

type LinkRow = {
	host: string;
	project: string;
	local_branch: string;
	remote_branch: string;
	url: string;
	number: number;
};

const EMPTY: Columns = {
	profile: null,
	issue_title: null,
	pipeline: null,
	unresolved_comment_count: null,
	pr_number: null,
	has_conflict: null,
	recap_custom_title: null,
	recap_last_prompt: null,
	recap_last_assistant_excerpt: null,
	agent_profile: null,
	agent_is_claude: null,
};

const COLUMN_NAMES = Object.keys(EMPTY) as Array<keyof Columns>;

function booleanColumn(value: boolean | undefined): 0 | 1 | null {
	if (value === undefined) return null;
	return value ? 1 : 0;
}

/** The columns a patch sets, and no others. */
function columnsOf(patch: SpaceStatePatch): Partial<Columns> {
	const columns: Partial<Columns> = {};
	if ('profile' in patch) columns.profile = patch.profile ?? null;
	if ('issueTitle' in patch) columns.issue_title = patch.issueTitle ?? null;
	if ('pipeline' in patch) {
		columns.pipeline =
			patch.pipeline === undefined ? null : (patch.pipeline ?? NO_PIPELINE);
	}

	if ('unresolvedCommentCount' in patch)
		columns.unresolved_comment_count = patch.unresolvedCommentCount ?? null;
	if ('prNumber' in patch) columns.pr_number = patch.prNumber ?? null;
	if ('hasConflict' in patch)
		columns.has_conflict = booleanColumn(patch.hasConflict);
	if ('recap' in patch) {
		columns.recap_custom_title = patch.recap?.customTitle ?? null;
		columns.recap_last_prompt = patch.recap?.lastPrompt ?? null;
		columns.recap_last_assistant_excerpt =
			patch.recap?.lastAssistantExcerpt ?? null;
	}

	if ('agentProfile' in patch) {
		columns.agent_profile = patch.agentProfile?.name ?? null;
		columns.agent_is_claude = booleanColumn(patch.agentProfile?.isClaude);
	}

	return columns;
}

function toLink(row: LinkRow): SpacePrLink {
	return {
		host: row.host,
		project: row.project,
		localBranch: row.local_branch,
		remoteBranch: row.remote_branch,
		url: row.url,
		number: row.number,
	};
}

function toState(row: Row | null, links: SpacePrLink[]): SpaceState | null {
	if (!row && links.length === 0) return null;
	const stored: Row = row ?? {...EMPTY, updated_at: null};
	const recap = {
		...(stored.recap_custom_title === null
			? {}
			: {customTitle: stored.recap_custom_title}),
		...(stored.recap_last_prompt === null
			? {}
			: {lastPrompt: stored.recap_last_prompt}),
		...(stored.recap_last_assistant_excerpt === null
			? {}
			: {lastAssistantExcerpt: stored.recap_last_assistant_excerpt}),
	};
	return {
		...(links.length > 0 ? {prLinks: links} : {}),
		...(stored.pipeline === null
			? {}
			: {pipeline: stored.pipeline === NO_PIPELINE ? null : stored.pipeline}),
		...(stored.unresolved_comment_count === null
			? {}
			: {unresolvedCommentCount: stored.unresolved_comment_count}),
		...(stored.pr_number === null ? {} : {prNumber: stored.pr_number}),
		...(stored.has_conflict === null
			? {}
			: {hasConflict: stored.has_conflict === 1}),
		...(Object.keys(recap).length > 0 ? {recap} : {}),
		...(stored.updated_at === null ? {} : {updatedAt: stored.updated_at}),
		...(stored.profile === null ? {} : {profile: stored.profile}),
		...(stored.issue_title === null ? {} : {issueTitle: stored.issue_title}),
		...(stored.agent_profile === null || stored.agent_is_claude === null
			? {}
			: {
					agentProfile: {
						name: stored.agent_profile,
						isClaude: stored.agent_is_claude === 1,
					},
				}),
	};
}

export class SqliteSpaceStateDao implements SpaceStateDao {
	private readonly reads = new GuardedReads(log, 'space state');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly clock: () => Date,
	) {}

	read(key: string): SpaceState | null {
		return this.reads.or(null, () => this.stored(key));
	}

	lookup(key: string): SpaceStateLookup {
		try {
			const state = this.stored(key);
			return state ? {kind: 'state', state} : {kind: 'none'};
		} catch (error) {
			return {kind: 'unreadable', error};
		}
	}

	async write(key: string, patch: SpaceStatePatch): Promise<void> {
		await this.writeMany([{key, patch}]);
	}

	async addPrLink(key: string, link: SpacePrLink): Promise<void> {
		await this.openDb().write(() => {
			if (isDeepStrictEqual(this.links(key).at(-1), link)) return;
			this.putLink(key, link);
		});
	}

	async writeMany(
		entries: Array<{key: string; patch: SpaceStatePatch}>,
	): Promise<void> {
		const updatedAt = this.clock().toISOString();
		await this.openDb().write(() => {
			for (const {key, patch} of entries)
				this.apply(key, columnsOf(patch), updatedAt);
		});
	}

	/**
	 * Replace a space's record with `state`, keeping its `updatedAt`, or remove
	 * it when `state` is null. For a caller inside a write transaction.
	 */
	replace(key: string, state: SpaceState | null): void {
		this.delete(key);
		if (state) this.insert(key, state);
	}

	/** Set the columns that differ from the row. False when none do. */
	private apply(
		key: string,
		columns: Partial<Columns>,
		updatedAt: string,
	): boolean {
		const current: Columns = this.row(key) ?? EMPTY;
		const changed = COLUMN_NAMES.filter(
			name => name in columns && columns[name] !== current[name],
		);
		if (changed.length === 0) return false;
		const {db} = this.openDb();
		db.query(
			`INSERT INTO space_state (repo, key) VALUES (?, ?)
			ON CONFLICT (repo, key) DO NOTHING`,
		).run(this.repo, key);
		// One statement, so a pair of columns that must be set together never
		// fails its check halfway.
		db.query(
			`UPDATE space_state SET ${changed.map(name => `${name} = ?`).join(', ')},
				updated_at = ? WHERE repo = ? AND key = ?`,
		).run(
			...changed.map(name => columns[name] ?? null),
			updatedAt,
			this.repo,
			key,
		);
		return true;
	}

	private stored(key: string): SpaceState | null {
		return toState(this.row(key), this.links(key));
	}

	private row(key: string): Row | null {
		return this.openDb()
			.db.query<Row, [string, string]>(
				`SELECT ${COLUMN_NAMES.join(', ')}, updated_at FROM space_state
				WHERE repo = ? AND key = ?`,
			)
			.get(this.repo, key);
	}

	private links(key: string): SpacePrLink[] {
		return this.openDb()
			.db.query<LinkRow, [string, string]>(
				`SELECT host, project, local_branch, remote_branch, url, number
				FROM space_pr_links WHERE repo = ? AND key = ? ORDER BY seq`,
			)
			.all(this.repo, key)
			.map(row => toLink(row));
	}

	/** The newest link has the highest `seq`, so a replaced link moves last. */
	private putLink(key: string, link: SpacePrLink): void {
		this.openDb()
			.db.query(
				`INSERT INTO space_pr_links
					(repo, key, host, project, local_branch, remote_branch, url, number, seq)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (
					SELECT COALESCE(MAX(seq), 0) + 1 FROM space_pr_links
					WHERE repo = ?1 AND key = ?2
				))
				ON CONFLICT (repo, key, host, project, local_branch) DO UPDATE SET
					remote_branch = excluded.remote_branch, url = excluded.url,
					number = excluded.number, seq = excluded.seq`,
			)
			.run(
				this.repo,
				key,
				link.host,
				link.project,
				link.localBranch,
				link.remoteBranch,
				link.url,
				link.number,
			);
	}

	private insert(key: string, state: SpaceState): void {
		const columns = {...EMPTY, ...columnsOf(state)};
		this.openDb()
			.db.query(
				`INSERT INTO space_state (repo, key, ${COLUMN_NAMES.join(', ')}, updated_at)
				VALUES (?, ?, ${COLUMN_NAMES.map(() => '?').join(', ')}, ?)`,
			)
			.run(
				this.repo,
				key,
				...COLUMN_NAMES.map(name => columns[name]),
				state.updatedAt ?? null,
			);
		for (const link of state.prLinks ?? []) this.putLink(key, link);
	}

	private delete(key: string): void {
		const {db} = this.openDb();
		db.query('DELETE FROM space_state WHERE repo = ? AND key = ?').run(
			this.repo,
			key,
		);
		db.query('DELETE FROM space_pr_links WHERE repo = ? AND key = ?').run(
			this.repo,
			key,
		);
	}
}
