import {
	attachStatusMonitor,
	monitorPane,
	type StatusPane,
} from './program-status-monitor.ts';

const [command, repo, key, sessionOrSocket, socketOrPane, dir, traceDir] =
	process.argv.slice(2);
if (!repo || !key || !sessionOrSocket) process.exitCode = 1;
else if (command === 'attach')
	await attachStatusMonitor(repo, key, sessionOrSocket, socketOrPane);
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
	);
else process.exitCode = 1;
import {Buffer} from 'node:buffer';
