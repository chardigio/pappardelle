// The composition root for Pappardelle's stores.
//
// Each store is a DAO with a file-backed implementation and one for
// experimental.sqliteState: SQLite-backed, or for hook status the status
// daemon. This is the one place that decides which a process gets, so nothing
// else reads the flag, and removing the flag changes this file.

import path from 'node:path';
import {SqliteAgentSessionsDao} from './agent-sessions-sqlite.ts';
import {JsonClaudeStatusDao, type ClaudeStatusDao} from './claude-status.ts';
import {DaemonClaudeStatusDao} from './claude-status-daemon.ts';
import {
	companionRequestsDir,
	companionWidthsPath,
	JsonCompanionRequestDao,
	JsonCompanionWidthDao,
	type CompanionRequestDao,
	type CompanionWidthDao,
} from './companion-width.ts';
import {
	SqliteCompanionRequestDao,
	SqliteCompanionWidthDao,
} from './companion-width-sqlite.ts';
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
	JsonPrLinkStampDao,
	prLinkStampPath,
	type PrLinkStampDao,
} from './pr-link-stamp.ts';
import {SqlitePrLinkStampDao} from './pr-link-stamp-sqlite.ts';
import type {ProgramStatusDao} from './program-status-monitor.ts';
import {createProgramStatusDao} from './program-status-sqlite.ts';
import {
	getStateColorsPath,
	JsonStateColorDao,
	migrateLegacyStateColors,
	type StateColorDao,
} from './providers/state-color-cache.ts';
import {SqliteStateColorDao} from './providers/state-color-cache-sqlite.ts';
import {
	JsonScheduleDao,
	queuedMessagesDir,
	schedulesDir,
	type ScheduleDao,
} from './schedule.ts';
import {SqliteScheduleDao} from './schedule-sqlite.ts';
import {
	getRegistryPathForRepo,
	JsonSpaceRegistryDao,
	migrateLegacyRegistry,
	type SpaceRegistryDao,
} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import {
	getSpaceStateDir,
	JsonAgentSessionsDao,
	JsonSpaceStateDao,
	type AgentSessionsDao,
	type SpaceStateDao,
} from './space-state.ts';
import {SqliteSpaceStateDao} from './space-state-sqlite.ts';
import {
	checkpointOutsideWrites,
	DEFAULT_STATE_DIR,
	openStateDb,
	stateDbPath,
	statusSocketPath,
} from './state-db.ts';
import {readStateEnv} from './state-env.ts';
import {StatusClient} from './status-client.ts';
import {
	JsonTuiMarkerDao,
	tuiMarkerPath,
	type TuiMarkerDao,
} from './tui-marker.ts';
import {SqliteTuiMarkerDao} from './tui-marker-sqlite.ts';
import {
	JsonUpdateCheckDao,
	updateCheckPath,
	type UpdateCheckDao,
} from './update-check.ts';
import {SqliteUpdateCheckDao} from './update-check-sqlite.ts';

export type StateDaos = {
	registry: SpaceRegistryDao;
	claudeStatus: ClaudeStatusDao;
	spaceState: SpaceStateDao;
	issueMeta: IssueMetaDao;
	highlight: HighlightDao;
	stateColors: StateColorDao;
	agentSessions: AgentSessionsDao;
	companionWidths: CompanionWidthDao;
	companionRequests: CompanionRequestDao;
	schedules: ScheduleDao;
	prLinkStamp: PrLinkStampDao;
	programStatus: ProgramStatusDao;
	tuiMarker: TuiMarkerDao;
	updateCheck: UpdateCheckDao;
	/**
	 * Keep checkpoints of the state database out of this process's writes.
	 * For the process that renders the TUI.
	 */
	deferCheckpoints(): void;
	/**
	 * Close this process's connection to the status daemon. A process that
	 * exits has no need to: the connection does not keep it alive.
	 */
	disconnectStatusDaemon(): void;
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
	configured ??= readStateEnv().sqliteState ?? readHomeSqliteState();
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
	const jsonClaudeStatus = new JsonClaudeStatusDao(
		readStateEnv().claudeStatusDir ?? path.join(stateDir, 'claude-status'),
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
	const jsonAgentSessions = new JsonAgentSessionsDao(
		getSpaceStateDir(repo, stateDir),
	);
	const jsonCompanionWidths = new JsonCompanionWidthDao(
		companionWidthsPath(repo, stateDir),
	);
	const jsonCompanionRequests = new JsonCompanionRequestDao(
		companionRequestsDir(repo, stateDir),
	);
	const jsonSchedules = new JsonScheduleDao(
		schedulesDir(repo, stateDir),
		queuedMessagesDir(repo, stateDir),
	);
	const jsonPrLinkStamp = new JsonPrLinkStampDao(
		prLinkStampPath(stateDir),
		clock,
	);
	const dbPath = options.dbPath ?? stateDbPath(options.stateDir);
	const sqlite = options.sqlite ?? sqliteStateEnabled();
	// Applied when a store first opens the connection, so that asking for it
	// does not open a database nothing has used yet.
	let checkpointsDeferred = false;
	const openDb = () => {
		const state = openStateDb(dbPath);
		if (checkpointsDeferred) checkpointOutsideWrites(state);
		return state;
	};
	const programStatus = createProgramStatusDao({
		sqlite,
		repo,
		stateDir,
		dbPath,
		openDb,
	});
	const tuiMarkerFile = tuiMarkerPath(path.join(stateDir, 'repos'), repo);
	const updateCheckFile = updateCheckPath(stateDir);
	if (!sqlite) {
		return {
			registry: jsonRegistry,
			claudeStatus: jsonClaudeStatus,
			spaceState: jsonSpaceState,
			issueMeta: jsonIssueMeta,
			highlight: new JsonHighlightDao(highlightFile),
			stateColors: new JsonStateColorDao(stateColorsFile),
			agentSessions: jsonAgentSessions,
			companionWidths: jsonCompanionWidths,
			companionRequests: jsonCompanionRequests,
			schedules: jsonSchedules,
			prLinkStamp: jsonPrLinkStamp,
			programStatus,
			tuiMarker: new JsonTuiMarkerDao(tuiMarkerFile),
			updateCheck: new JsonUpdateCheckDao(updateCheckFile),
			deferCheckpoints() {},
			disconnectStatusDaemon() {},
		};
	}

	const statusClient = new StatusClient(statusSocketPath(options.stateDir), {
		repo,
	});
	return {
		registry: new SqliteSpaceRegistryDao(openDb, repo, jsonRegistry),
		claudeStatus: new DaemonClaudeStatusDao(statusClient),
		spaceState: new SqliteSpaceStateDao(openDb, repo, jsonSpaceState, clock),
		issueMeta: new SqliteIssueMetaDao(openDb, repo, jsonIssueMeta, clock),
		highlight: new SqliteHighlightDao(
			openDb,
			dbPath,
			repo,
			highlightFile,
			clock,
		),
		stateColors: new SqliteStateColorDao(openDb, repo, stateColorsFile),
		agentSessions: new SqliteAgentSessionsDao(openDb, repo, jsonAgentSessions),
		companionWidths: new SqliteCompanionWidthDao(
			openDb,
			repo,
			jsonCompanionWidths,
		),
		companionRequests: new SqliteCompanionRequestDao(
			openDb,
			dbPath,
			repo,
			jsonCompanionRequests,
		),
		schedules: new SqliteScheduleDao(openDb, repo, jsonSchedules),
		prLinkStamp: new SqlitePrLinkStampDao(openDb, jsonPrLinkStamp, clock),
		programStatus,
		tuiMarker: new SqliteTuiMarkerDao(openDb, repo, tuiMarkerFile),
		updateCheck: new SqliteUpdateCheckDao(openDb, updateCheckFile),
		deferCheckpoints() {
			checkpointsDeferred = true;
		},
		disconnectStatusDaemon() {
			statusClient.close();
		},
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
