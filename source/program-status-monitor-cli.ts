import {monitorPane, type StatusPane} from './program-status-monitor.ts';
import {
	createProgramStatusDao,
	followedSnapshotRows,
} from './program-status-sqlite.ts';
import {DEFAULT_STATE_DIR, openStateDb, stateDbPath} from './state-db.ts';
import {readResolvedSqliteState} from './state-flag.ts';

// This entry runs once per agent launch and stays up for the life of each
// agent pane, so it reads the flag the CLI recorded and does not load the
// config.

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
	await createProgramStatusDao({
		sqlite: readResolvedSqliteState(),
		repo,
		stateDir: DEFAULT_STATE_DIR,
		dbPath: stateDbPath(),
		openDb: () => openStateDb(stateDbPath()),
	}).attach(key, sessionOrSocket, socketOrPane);
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
		dbPath
			? followedSnapshotRows(
					() => openStateDb(dbPath),
					() => readResolvedSqliteState(),
				)
			: undefined,
	);
else process.exitCode = 1;
import {Buffer} from 'node:buffer';
