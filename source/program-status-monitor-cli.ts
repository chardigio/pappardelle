import {Buffer} from 'node:buffer';
import {
	createProgramStatusDao,
	daemonPublisher,
} from './program-status-daemon.ts';
import {monitorPane, type StatusPane} from './program-status-monitor.ts';
import {DEFAULT_STATE_DIR, statusSocketPath} from './state-db.ts';
import {StatusClient} from './status-client.ts';

// This entry runs once per agent launch and stays up for the life of each
// agent pane.

const [command, ...args] = process.argv.slice(2);
if (command === 'attach') {
	const [repo, key, session, socket] = args;
	if (repo && key && session) {
		const socketPath = statusSocketPath();
		await createProgramStatusDao({
			repo,
			stateDir: DEFAULT_STATE_DIR,
			socketPath,
			statusClient: new StatusClient(socketPath),
		}).attach(key, session, socket);
	} else process.exitCode = 1;
} else if (command === 'watch') {
	const [repo, key, pane, dir, traceDir, statusSocket] = args;
	if (repo && key && pane && dir && statusSocket)
		monitorPane(
			repo,
			key,
			JSON.parse(Buffer.from(pane, 'base64').toString('utf8')) as StatusPane,
			daemonPublisher({dir, socketPath: statusSocket}),
			traceDir || undefined,
		);
	else process.exitCode = 1;
} else process.exitCode = 1;
