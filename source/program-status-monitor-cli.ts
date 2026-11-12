import {
	JsonProgramStatusDao,
	monitorPane,
	programStatusDir,
	type ProgramStatusDao,
	type StatusPane,
} from './program-status-monitor.ts';
import {
	SqliteProgramStatusDao,
	SqliteSnapshotRows,
} from './program-status-sqlite.ts';
import {DEFAULT_STATE_DIR, openStateDb, stateDbPath} from './state-db.ts';
import {readResolvedSqliteState} from './state-flag.ts';

// This entry runs once per agent launch and stays up for the life of each
// agent pane, so it reads the flag the CLI recorded and does not load the
// config.

const FLAG_MAX_AGE_MS = 1000;

function programStatus(repo: string): ProgramStatusDao {
	const dbPath = stateDbPath();
	const json = new JsonProgramStatusDao(
		repo,
		programStatusDir(repo, DEFAULT_STATE_DIR),
		dbPath,
	);
	return readResolvedSqliteState()
		? new SqliteProgramStatusDao(() => openStateDb(dbPath), json)
		: json;
}

/**
 * The rows a monitor writes, while experimental.sqliteState is on. A monitor
 * outlives a change of the flag, so it looks again every second.
 */
function followedRows(dbPath: string): () => SqliteSnapshotRows | undefined {
	const rows = new SqliteSnapshotRows(() => openStateDb(dbPath));
	let enabled = false;
	let readAt = Number.NEGATIVE_INFINITY;
	return () => {
		if (performance.now() - readAt >= FLAG_MAX_AGE_MS) {
			enabled = readResolvedSqliteState();
			readAt = performance.now();
		}

		return enabled ? rows : undefined;
	};
}

const [
	command,
	repo,
	key,
	sessionOrSocket,
	socketOrPane,
	dir,
	traceDir,
	dbPath,
] = process.argv.slice(2);
if (!repo || !key || !sessionOrSocket) process.exitCode = 1;
else if (command === 'attach')
	await programStatus(repo).attach(key, sessionOrSocket, socketOrPane);
else if (command === 'watch' && socketOrPane && dir)
	monitorPane(
		repo,
		key,
		sessionOrSocket,
		JSON.parse(
			Buffer.from(socketOrPane, 'base64').toString('utf8'),
		) as StatusPane,
		dir,
		traceDir || undefined,
		dbPath ? followedRows(dbPath) : undefined,
	);
else process.exitCode = 1;
import {Buffer} from 'node:buffer';
