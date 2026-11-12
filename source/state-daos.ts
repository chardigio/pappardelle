// The composition root for Pappardelle's stores.
//
// Each store is a DAO with a file-backed and a SQLite-backed implementation.
// This is the one place that decides which a process gets, so nothing else
// reads experimental.sqliteState, and removing the flag changes this file.

import path from 'node:path';
import {JsonClaudeStatusDao, type ClaudeStatusDao} from './claude-status.ts';
import {SqliteClaudeStatusDao} from './claude-status-sqlite.ts';
import {readHomeSqliteState} from './config.ts';
import {
	getHighlightFilePath,
	JsonHighlightDao,
	type HighlightDao,
} from './highlight.ts';
import {SqliteHighlightDao} from './highlight-sqlite.ts';
import {JsonIssueMetaDao, type IssueMetaDao} from './issue-meta.ts';
import {SqliteIssueMetaDao} from './issue-meta-sqlite.ts';
import {
	getStateColorsPath,
	JsonStateColorDao,
	migrateLegacyStateColors,
	type StateColorDao,
} from './providers/state-color-cache.ts';
import {SqliteStateColorDao} from './providers/state-color-cache-sqlite.ts';
import {
	getRegistryPathForRepo,
	JsonSpaceRegistryDao,
	migrateLegacyRegistry,
	type SpaceRegistryDao,
} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import {
	getSpaceStateDir,
	JsonSpaceStateDao,
	type SpaceStateDao,
} from './space-state.ts';
import {SqliteSpaceStateDao} from './space-state-sqlite.ts';
import {DEFAULT_STATE_DIR, openStateDb, stateDbPath} from './state-db.ts';
import {sqliteStateOverride} from './state-flag.ts';

export type StateDaos = {
	registry: SpaceRegistryDao;
	claudeStatus: ClaudeStatusDao;
	spaceState: SpaceStateDao;
	issueMeta: IssueMetaDao;
	highlight: HighlightDao;
	stateColors: StateColorDao;
};

export type StateDaoOptions = {
	repo: string;
	/** Where the state files live, and the database unless `dbPath` says otherwise. */
	stateDir?: string;
	dbPath?: string;
	/** Which implementation to build. Defaults to experimental.sqliteState. */
	sqlite?: boolean;
	/** The time recorded on a write. */
	clock?: () => Date;
};

let configured: boolean | undefined;

/** experimental.sqliteState for this process: the override, then the home config. */
export function sqliteStateEnabled(): boolean {
	configured ??= sqliteStateOverride() ?? readHomeSqliteState();
	return configured;
}

export function createStateDaos(options: StateDaoOptions): StateDaos {
	const {repo} = options;
	const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
	migrateLegacyRegistry(repo, stateDir);
	migrateLegacyStateColors(repo, stateDir);
	const jsonRegistry = new JsonSpaceRegistryDao(
		getRegistryPathForRepo(repo, stateDir),
	);
	// The hook reads the same variable, so a test or a timer service moves the
	// files for the writer and the readers at once.
	const jsonClaudeStatus = new JsonClaudeStatusDao(
		process.env['PAPPARDELLE_STATUS_DIR'] ??
			path.join(stateDir, 'claude-status'),
	);
	const clock = options.clock ?? (() => new Date());
	const jsonSpaceState = new JsonSpaceStateDao(
		getSpaceStateDir(repo, stateDir),
		clock,
	);
	const jsonIssueMeta = new JsonIssueMetaDao(
		path.join(stateDir, 'repos', repo, 'issue-meta'),
		clock,
	);
	const highlightFile = getHighlightFilePath(repo, stateDir);
	const stateColorsFile = getStateColorsPath(repo, stateDir);
	if (!(options.sqlite ?? sqliteStateEnabled())) {
		return {
			registry: jsonRegistry,
			claudeStatus: jsonClaudeStatus,
			spaceState: jsonSpaceState,
			issueMeta: jsonIssueMeta,
			highlight: new JsonHighlightDao(highlightFile),
			stateColors: new JsonStateColorDao(stateColorsFile),
		};
	}

	const dbPath = options.dbPath ?? stateDbPath(options.stateDir);
	const openDb = () => openStateDb(dbPath);
	return {
		registry: new SqliteSpaceRegistryDao(openDb, repo, jsonRegistry),
		claudeStatus: new SqliteClaudeStatusDao(openDb, jsonClaudeStatus),
		spaceState: new SqliteSpaceStateDao(openDb, repo, jsonSpaceState, clock),
		issueMeta: new SqliteIssueMetaDao(openDb, repo, jsonIssueMeta, clock),
		highlight: new SqliteHighlightDao(openDb, repo, highlightFile, clock),
		stateColors: new SqliteStateColorDao(openDb, repo, stateColorsFile),
	};
}

/**
 * Stores for a repo that is only known once a path has been looked at (a
 * workspace handed to link-pr, a checkout the rail discovered), built once
 * per repo.
 */
export function stateDaosByRepo(
	options: Omit<StateDaoOptions, 'repo'> = {},
): (repo: string) => StateDaos {
	const built = new Map<string, StateDaos>();
	return repo => {
		const daos = built.get(repo) ?? createStateDaos({...options, repo});
		built.set(repo, daos);
		return daos;
	};
}
