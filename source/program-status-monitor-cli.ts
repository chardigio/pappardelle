// First, so nothing this process starts inherits the terminal's OSC 7577 token.
// eslint-disable-next-line import-x/no-unassigned-import
import './resume-token.ts';
import {Buffer} from 'node:buffer';
import {
	createProgramStatusDao,
	daemonPublisher,
} from './program-status-daemon.ts';
import {monitorPane, type StatusPane} from './program-status-monitor.ts';
import {
	monitorResumePane,
	parseResumeWatchArgv,
	watchResume,
} from './resume-monitor.ts';
import {DEFAULT_STATE_DIR, stateDbPath, statusSocketPath} from './state-db.ts';
import {parseResumePaneId} from './program-resume.ts';
import {StatusClient} from './status-client.ts';

// This entry runs once per agent launch and stays up for the life of each
// agent pane, and once per companion pane for its resume records.

async function attach(args: string[]): Promise<number> {
	const [repo, key, session, socket, resumePane, monitorTokenFile] = args;
	if (!repo || !key || !session) return 1;
	const pane = resumePane ? parseResumePaneId(resumePane) : undefined;
	const socketPath = statusSocketPath();
	await createProgramStatusDao({
		repo,
		stateDir: DEFAULT_STATE_DIR,
		socketPath,
		statusClient: new StatusClient(socketPath),
	}).attach(
		key,
		session,
		socket,
		undefined,
		pane && monitorTokenFile
			? {pane, monitorTokenFile, dbPath: stateDbPath()}
			: undefined,
	);
	return 0;
}

function watch(args: string[]): number {
	const [repo, key, pane, dir, traceDir, statusSocket, ...resumeArgs] = args;
	if (!repo || !key || !pane || !dir || !statusSocket) return 1;
	// An agent pane's monitor also keeps its resume records when its launch
	// gave it a token file.
	const resume = parseResumeWatchArgv(repo, key, resumeArgs);
	monitorPane(
		repo,
		key,
		JSON.parse(Buffer.from(pane, 'base64').toString('utf8')) as StatusPane,
		daemonPublisher({dir, socketPath: statusSocket}),
		traceDir || undefined,
		resume && watchResume(resume),
	);
	return 0;
}

// A companion pane's monitor, started by pipe-pane with the pane's own
// session. Its argv is the space, then resumeWatchArgv.
function resumeWatch(args: string[]): number {
	const [repo, key, ...resumeArgs] = args;
	const resume =
		repo && key ? parseResumeWatchArgv(repo, key, resumeArgs) : undefined;
	if (!resume) return 1;
	monitorResumePane(watchResume(resume), resume.panePid);
	return 0;
}

const [command, ...args] = process.argv.slice(2);
switch (command ?? '') {
	case 'attach': {
		process.exitCode = await attach(args);
		break;
	}
	case 'watch': {
		process.exitCode = watch(args);
		break;
	}
	case 'resume-watch': {
		process.exitCode = resumeWatch(args);
		break;
	}
	case 'prepare':
	case 'commit': {
		// start-agent-session.sh's launch of a resumable pane, so the restore
		// logic lives here only.
		const {runLaunchVerb} = await import('./resume-launch-cli.ts');
		process.exitCode = await runLaunchVerb(
			command === 'prepare' ? 'prepare' : 'commit',
			args,
		);
		break;
	}
	default: {
		process.exitCode = 1;
	}
}
