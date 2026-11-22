import {serveStatusDaemon} from './status-daemon.ts';

// Started detached by a TUI or a pane monitor that found no daemon. Several
// can be started at once; all but one find the socket served and exit.

const [socketPath] = process.argv.slice(2);
if (socketPath) {
	const start = await serveStatusDaemon(socketPath);
	if (start.kind === 'failed') process.exitCode = 1;
} else {
	process.exitCode = 1;
}
