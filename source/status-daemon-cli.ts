// First, so nothing this process starts inherits the terminal's OSC 7577 token.
// eslint-disable-next-line import-x/no-unassigned-import
import './resume-token.ts';
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
