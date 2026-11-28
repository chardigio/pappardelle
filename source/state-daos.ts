// The composition root for Pappardelle's stores: SQLite-backed, or for the
// two status signals the status daemon.

import {homedir} from 'node:os';
import {SqliteAgentSessionsDao} from './agent-sessions-sqlite.ts';
import type {ClaudeStatusDao} from './claude-status.ts';
import {DaemonClaudeStatusDao} from './claude-status-daemon.ts';
import type {
	CompanionRequestDao,
	CompanionWidthDao,
} from './companion-width.ts';
import {
	SqliteCompanionRequestDao,
	SqliteCompanionWidthDao,
} from './companion-width-sqlite.ts';
import {getMainRepoRoot} from './config.ts';
import type {HoldDao} from './holds.ts';
import {SqliteHoldDao} from './holds-sqlite.ts';
import type {HighlightDao} from './highlight.ts';
import {SqliteHighlightDao} from './highlight-sqlite.ts';
import type {IssueMetaDao} from './issue-meta.ts';
import {SqliteIssueMetaDao} from './issue-meta-sqlite.ts';
import type {PrLinkStampDao} from './pr-link-stamp.ts';
import {SqlitePrLinkStampDao} from './pr-link-stamp-sqlite.ts';
import {createProgramStatusDao} from './program-status-daemon.ts';
import {statusSocket, type ProgramStatusDao} from './program-status-monitor.ts';
import type {StateColorDao} from './providers/state-color-cache.ts';
import {SqliteStateColorDao} from './providers/state-color-cache-sqlite.ts';
import type {ScheduleDao} from './schedule.ts';
import {
	type ResumeRecordDao,
	SqliteResumeRecordDao,
} from './resume-records-sqlite.ts';
import {SqliteScheduleDao} from './schedule-sqlite.ts';
import type {IdentityDefaults, SpaceIdentityDao} from './space-identity.ts';
import {SqliteSpaceIdentityDao} from './space-identity-sqlite.ts';
import type {SpaceRegistryDao} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import type {AgentSessionsDao} from './agent-sessions.ts';
import type {SpaceStateDao} from './space-state.ts';
import {SqliteSpaceStateDao} from './space-state-sqlite.ts';
import {
	checkpointOutsideWrites,
	DEFAULT_STATE_DIR,
	stateDbPath,
	statusSocketPath,
} from './state-db.ts';
import {openImportedStateDb} from './state-import.ts';
import {StatusClient} from './status-client.ts';
import type {TuiMarkerDao} from './tui-marker.ts';
import {SqliteTuiMarkerDao} from './tui-marker-sqlite.ts';
import type {UpdateCheckDao} from './update-check.ts';
import {SqliteUpdateCheckDao} from './update-check-sqlite.ts';

export type StateDaos = {
	registry: SpaceRegistryDao;
	spaceIdentities: SpaceIdentityDao;
	claudeStatus: ClaudeStatusDao;
	spaceState: SpaceStateDao;
	issueMeta: IssueMetaDao;
	highlight: HighlightDao;
	stateColors: StateColorDao;
	agentSessions: AgentSessionsDao;
	companionWidths: CompanionWidthDao;
	companionRequests: CompanionRequestDao;
	schedules: ScheduleDao;
	holds: HoldDao;
	prLinkStamp: PrLinkStampDao;
	programStatus: ProgramStatusDao;
	resumeRecords: ResumeRecordDao;
	/** Where the state files and the database live, for a process this one starts. */
	stateDir: string;
	dbPath: string;
	tuiMarker: TuiMarkerDao;
	updateCheck: UpdateCheckDao;
	/**
	 * Keep checkpoints of the state database out of this process's writes.
	 * For the process that renders the TUI.
	 */
	deferCheckpoints(): void;
	/**
	 * From now on this process starts the status daemon when none runs. For
	 * the process that renders the TUI: a CLI verb reads what a running daemon
	 * holds and never starts one.
	 */
	allowStatusDaemonStart(): void;
	/**
	 * Close this process's connection to the status daemon. A process that
	 * exits has no need to: the connection does not keep it alive.
	 */
	disconnectStatusDaemon(): void;
};

export type StateDaoOptions = {
	repo: string;
	/** Where the state files and the database live. */
	stateDir?: string;
	/** The time recorded on a write. */
	clock?: () => Date;
	/** The home whose `~/.worktrees` holds the spaces idow creates. */
	home?: string;
	/** The environment that names the inner tmux socket. */
	env?: NodeJS.ProcessEnv;
	/** The main checkout's root. Throws outside a git checkout. */
	mainRoot?: () => string;
};

export function createStateDaos(options: StateDaoOptions): StateDaos {
	const {repo} = options;
	const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
	const identityDefaults: IdentityDefaults = {
		repo,
		home: options.home ?? homedir(),
		socket: statusSocket(options.env),
		mainRoot: options.mainRoot ?? getMainRepoRoot,
	};
	const clock = options.clock ?? (() => new Date());
	const dbPath = stateDbPath(options.stateDir);
	// Applied when a store first opens the connection, so that asking for it
	// does not open a database nothing has used yet.
	let checkpointsDeferred = false;
	const openDb = () => {
		const state = openImportedStateDb(dbPath, stateDir, identityDefaults);
		if (checkpointsDeferred) checkpointOutsideWrites(state);
		return state;
	};
	const socketPath = statusSocketPath(options.stateDir);
	const statusClient = new StatusClient(socketPath, {repo});
	const programStatus = createProgramStatusDao({
		repo,
		stateDir,
		socketPath,
		statusClient,
	});
	const spaceIdentities = new SqliteSpaceIdentityDao(openDb, identityDefaults);
	return {
		registry: new SqliteSpaceRegistryDao(openDb, repo, spaceIdentities),
		spaceIdentities,
		spaceState: new SqliteSpaceStateDao(openDb, repo, clock),
		issueMeta: new SqliteIssueMetaDao(openDb, repo, clock),
		highlight: new SqliteHighlightDao(openDb, dbPath, repo, clock),
		stateColors: new SqliteStateColorDao(openDb, repo),
		agentSessions: new SqliteAgentSessionsDao(openDb, repo),
		companionWidths: new SqliteCompanionWidthDao(openDb, repo),
		companionRequests: new SqliteCompanionRequestDao(openDb, dbPath, repo),
		schedules: new SqliteScheduleDao(openDb, repo),
		holds: new SqliteHoldDao(openDb, repo),
		prLinkStamp: new SqlitePrLinkStampDao(openDb, clock),
		resumeRecords: new SqliteResumeRecordDao(openDb, repo),
		stateDir,
		dbPath,
		tuiMarker: new SqliteTuiMarkerDao(openDb, repo),
		updateCheck: new SqliteUpdateCheckDao(openDb),
		claudeStatus: new DaemonClaudeStatusDao(statusClient),
		programStatus,
		deferCheckpoints() {
			checkpointsDeferred = true;
		},
		allowStatusDaemonStart() {
			statusClient.allowStart();
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
