// The composition root for Pappardelle's stores: SQLite-backed, or for the
// two status signals the status daemon.

import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {SqliteAgentSessionsDao} from './agent-sessions-sqlite.ts';
import type {ClaudeStatusDao} from './claude-status.ts';
import {DaemonClaudeStatusDao} from './claude-status-daemon.ts';
import {
	companionWidthsPath,
	type CompanionRequestDao,
	type CompanionWidthDao,
} from './companion-width.ts';
import {
	SqliteCompanionRequestDao,
	SqliteCompanionWidthDao,
} from './companion-width-sqlite.ts';
import {getMainRepoRoot} from './config.ts';
import {holdsDir, type HoldDao} from './holds.ts';
import {SqliteHoldDao} from './holds-sqlite.ts';
import {getHighlightFilePath, type HighlightDao} from './highlight.ts';
import {SqliteHighlightDao} from './highlight-sqlite.ts';
import {type IssueMetaDao} from './issue-meta.ts';
import {SqliteIssueMetaDao} from './issue-meta-sqlite.ts';
import {createLogger} from './logger.ts';
import {type PrLinkStampDao} from './pr-link-stamp.ts';
import {SqlitePrLinkStampDao} from './pr-link-stamp-sqlite.ts';
import {createProgramStatusDao} from './program-status-daemon.ts';
import {statusSocket, type ProgramStatusDao} from './program-status-monitor.ts';
import {
	getStateColorsPath,
	type StateColorDao,
} from './providers/state-color-cache.ts';
import {SqliteStateColorDao} from './providers/state-color-cache-sqlite.ts';
import {queuedMessagesDir, schedulesDir, type ScheduleDao} from './schedule.ts';
import {SqliteScheduleDao} from './schedule-sqlite.ts';
import {
	type IdentityDefaults,
	type SpaceIdentityDao,
} from './space-identity.ts';
import {SqliteSpaceIdentityDao} from './space-identity-sqlite.ts';
import {
	getRegistryPathForRepo,
	type SpaceRegistryDao,
} from './space-registry.ts';
import {SqliteSpaceRegistryDao} from './space-registry-sqlite.ts';
import {
	getSpaceStateDir,
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
	type JsonMirror,
	type StateDb,
} from './state-db.ts';
import {StatusClient} from './status-client.ts';
import {tuiMarkerPath, type TuiMarkerDao} from './tui-marker.ts';
import {SqliteTuiMarkerDao} from './tui-marker-sqlite.ts';
import {updateCheckPath, type UpdateCheckDao} from './update-check.ts';
import {SqliteUpdateCheckDao} from './update-check-sqlite.ts';

const log = createLogger('state-db');

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
	/** Where the state files live, and the database unless `dbPath` says otherwise. */
	stateDir?: string;
	dbPath?: string;
	/** The time recorded on a write. */
	clock?: () => Date;
	/** The home whose `~/.worktrees` holds the spaces idow creates. */
	home?: string;
	/** The environment that names the inner tmux socket. */
	env?: NodeJS.ProcessEnv;
	/** The main checkout's root. Throws outside a git checkout. */
	mainRoot?: () => string;
};

type Stores = Omit<
	StateDaos,
	| 'claudeStatus'
	| 'programStatus'
	| 'deferCheckpoints'
	| 'allowStatusDaemonStart'
	| 'disconnectStatusDaemon'
> & {
	/** Every JSON file this repo's stores kept before the database held them. */
	jsonMirrors(): JsonMirror[];
};

function sqliteStores(
	openDb: () => StateDb,
	options: {
		dbPath: string;
		/** Where the JSON files were, for the one-time import. */
		stateDir: string;
		identityDefaults: IdentityDefaults;
		clock: () => Date;
	},
): Stores {
	const {dbPath, stateDir, identityDefaults, clock} = options;
	const {repo} = identityDefaults;
	const spaceIdentities = new SqliteSpaceIdentityDao(openDb, identityDefaults);
	const registryFile = getRegistryPathForRepo(repo, stateDir);
	const registry = new SqliteSpaceRegistryDao(
		openDb,
		repo,
		{
			registry: registryFile,
			reservations: path.join(
				path.dirname(registryFile),
				'watchlist-spawns.json',
			),
		},
		spaceIdentities,
	);
	const spaceStateDir = getSpaceStateDir(repo, stateDir);
	const spaceState = new SqliteSpaceStateDao(
		openDb,
		repo,
		spaceStateDir,
		clock,
	);
	const issueMeta = new SqliteIssueMetaDao(
		openDb,
		repo,
		path.join(stateDir, 'repos', repo, 'issue-meta'),
		clock,
	);
	const highlight = new SqliteHighlightDao(
		openDb,
		dbPath,
		repo,
		getHighlightFilePath(repo, stateDir),
		clock,
	);
	const stateColors = new SqliteStateColorDao(
		openDb,
		repo,
		getStateColorsPath(repo, stateDir),
	);
	const agentSessions = new SqliteAgentSessionsDao(openDb, repo, spaceStateDir);
	const companionWidths = new SqliteCompanionWidthDao(
		openDb,
		repo,
		companionWidthsPath(repo, stateDir),
	);
	const schedules = new SqliteScheduleDao(openDb, repo, {
		jobs: schedulesDir(repo, stateDir),
		queue: queuedMessagesDir(repo, stateDir),
	});
	const holds = new SqliteHoldDao(openDb, repo, holdsDir(repo, stateDir));
	const tuiMarker = new SqliteTuiMarkerDao(
		openDb,
		repo,
		tuiMarkerPath(path.join(stateDir, 'repos'), repo),
	);
	return {
		registry,
		spaceIdentities,
		spaceState,
		issueMeta,
		highlight,
		stateColors,
		agentSessions,
		companionWidths,
		companionRequests: new SqliteCompanionRequestDao(openDb, dbPath, repo),
		schedules,
		holds,
		prLinkStamp: new SqlitePrLinkStampDao(openDb, clock),
		tuiMarker,
		updateCheck: new SqliteUpdateCheckDao(openDb, updateCheckPath(stateDir)),
		jsonMirrors: () => [
			...registry.jsonMirrors(),
			...spaceState.jsonMirrors(),
			...agentSessions.jsonMirrors(),
			...issueMeta.jsonMirrors(),
			...highlight.jsonMirrors(),
			...stateColors.jsonMirrors(),
			...companionWidths.jsonMirrors(),
			...schedules.jsonMirrors(),
			...holds.jsonMirrors(),
			...tuiMarker.jsonMirrors(),
		],
	};
}

const imported = new Set<string>();

/**
 * Import the JSON files every repo under `stateDir` kept before the database
 * held its state, once, and delete them. A database moved away from
 * `stateDir` is not the one those files belong to, so it imports none of them.
 */
function importJsonState(
	state: StateDb,
	stateDir: string,
	defaults: Omit<IdentityDefaults, 'repo'>,
): void {
	if (imported.has(state.path)) return;
	if (state.hasJsonToImport()) {
		const ownsFiles =
			path.resolve(state.path) ===
			path.join(path.resolve(stateDir), 'state.db');
		const files = state.importJson(() => {
			if (!ownsFiles) return [];
			const update = new SqliteUpdateCheckDao(
				() => state,
				updateCheckPath(stateDir),
			);
			return [
				...update.jsonMirrors(),
				...reposToImport(state, stateDir).flatMap(repo =>
					sqliteStores(() => state, {
						dbPath: state.path,
						stateDir,
						identityDefaults: {...defaults, repo},
						clock: () => new Date(),
					}).jsonMirrors(),
				),
			];
		});
		// What no store imports: hook status and its pending-files scratch,
		// and the pr-link stamp's file.
		const obsolete = ownsFiles
			? ['claude-status', 'pr-link.stamp'].map(name =>
					path.join(stateDir, name),
				)
			: [];
		if (ownsFiles) recordFlagForOlderMonitors(state.path, stateDir);
		for (const file of [...files, ...obsolete]) {
			try {
				fs.rmSync(file, {force: true, recursive: true});
			} catch (error) {
				log.warn(
					`Could not delete ${file} after importing it`,
					error instanceof Error ? error : undefined,
				);
			}
		}
	}

	imported.add(state.path);
}

/**
 * An agent pane's status monitor lives as long as the pane, and one started
 * by an older build sends its snapshots to the daemon only while this file
 * says the flag is on. Without it, such a pane would show no program status
 * until its agent relaunches.
 */
function recordFlagForOlderMonitors(dbPath: string, stateDir: string): void {
	try {
		fs.writeFileSync(
			path.join(stateDir, 'state-flag.json'),
			`${JSON.stringify({sqliteState: true, db: dbPath})}\n`,
		);
	} catch (error) {
		log.warn(
			'Could not tell status monitors from an older build to use the status daemon',
			error instanceof Error ? error : undefined,
		);
	}
}

/**
 * The repos with a directory under `<stateDir>/repos`, and those whose files
 * a write through the database recorded, even if a process without the
 * database has since removed them.
 */
function reposToImport(state: StateDb, stateDir: string): string[] {
	const reposDir = path.join(stateDir, 'repos');
	const repos = new Set<string>();
	try {
		for (const entry of fs.readdirSync(reposDir, {withFileTypes: true}))
			if (entry.isDirectory()) repos.add(entry.name);
	} catch {}

	for (const {path: file} of state.db
		.query<{path: string}, []>('SELECT path FROM json_sync')
		.all()) {
		const [repo, ...rest] = path.relative(reposDir, file).split(path.sep);
		if (repo && repo !== '..' && rest.length > 0) repos.add(repo);
	}

	return [...repos].sort();
}

/** Open the database at `dbPath`, importing the JSON state beside it the first time. */
export function openImportedStateDb(
	dbPath: string,
	stateDir = DEFAULT_STATE_DIR,
	defaults?: Omit<IdentityDefaults, 'repo'>,
): StateDb {
	const state = openStateDb(dbPath);
	importJsonState(
		state,
		stateDir,
		defaults ?? {
			home: homedir(),
			socket: statusSocket(),
			mainRoot: getMainRepoRoot,
		},
	);
	return state;
}

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
	const dbPath = options.dbPath ?? stateDbPath(options.stateDir);
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
	const {jsonMirrors: _jsonMirrors, ...stores} = sqliteStores(openDb, {
		dbPath,
		stateDir,
		identityDefaults,
		clock,
	});
	return {
		...stores,
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
