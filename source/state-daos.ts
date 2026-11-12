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
	getRegistryPathForRepo,
	JsonSpaceRegistryDao,
	migrateLegacyRegistry,
	type SpaceRegistryDao,
} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import {DEFAULT_STATE_DIR, openStateDb, stateDbPath} from './state-db.ts';
import {sqliteStateOverride} from './state-flag.ts';

export type StateDaos = {
	registry: SpaceRegistryDao;
	claudeStatus: ClaudeStatusDao;
};

export type StateDaoOptions = {
	repo: string;
	/** Where the state files live, and the database unless `dbPath` says otherwise. */
	stateDir?: string;
	dbPath?: string;
	/** Which implementation to build. Defaults to experimental.sqliteState. */
	sqlite?: boolean;
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
	const jsonRegistry = new JsonSpaceRegistryDao(
		getRegistryPathForRepo(repo, stateDir),
	);
	// The hook reads the same variable, so a test or a timer service moves the
	// files for the writer and the readers at once.
	const jsonClaudeStatus = new JsonClaudeStatusDao(
		process.env['PAPPARDELLE_STATUS_DIR'] ??
			path.join(stateDir, 'claude-status'),
	);
	if (!(options.sqlite ?? sqliteStateEnabled())) {
		return {registry: jsonRegistry, claudeStatus: jsonClaudeStatus};
	}

	const dbPath = options.dbPath ?? stateDbPath(options.stateDir);
	const openDb = () => openStateDb(dbPath);
	return {
		registry: new SqliteSpaceRegistryDao(openDb, repo, jsonRegistry),
		claudeStatus: new SqliteClaudeStatusDao(openDb, jsonClaudeStatus),
	};
}
