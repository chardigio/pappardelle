import {Buffer} from 'node:buffer';
import {
	createProgramStatusDao,
	followedPublisher,
} from './program-status-daemon.ts';
import {monitorPane, type StatusPane} from './program-status-monitor.ts';
import {DEFAULT_STATE_DIR, statusSocketPath} from './state-db.ts';
import {readResolvedSqliteState} from './state-flag.ts';
import {StatusClient} from './status-client.ts';

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
	statusSocket,
] = process.argv.slice(2);
if (!repo || !key || !sessionOrSocket) process.exitCode = 1;
else if (command === 'attach') {
	const socketPath = statusSocketPath();
	await createProgramStatusDao({
		repo,
		stateDir: DEFAULT_STATE_DIR,
		socketPath,
		statusClient: readResolvedSqliteState()
			? new StatusClient(socketPath)
			: undefined,
	}).attach(key, sessionOrSocket, socketOrPane);
} else if (command === 'watch' && socketOrPane && dir && statusSocket)
	monitorPane(
		repo,
		key,
		sessionOrSocket,
		JSON.parse(
			Buffer.from(socketOrPane, 'base64').toString('utf8'),
		) as StatusPane,
		dir,
		followedPublisher({
			dir,
			socketPath: statusSocket,
			daemonMode: () => readResolvedSqliteState(),
		}),
		traceDir || undefined,
	);
else process.exitCode = 1;
