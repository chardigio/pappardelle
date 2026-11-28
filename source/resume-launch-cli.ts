// `--internal-status-monitor prepare|commit`: a resumable pane's launch for
// start-agent-session.sh, which starts the panes idow opens.
//
//   prepare <repo> <key> <pane> <dir> <report-exit 0|1> <command>
//     prints, NUL-separated: the monitor's token file, the token's hash, a
//     companion pane's pipe-pane command (empty for the agent), then the
//     pane's argv
//   commit <repo> <key> <pane> <token-hash>
//     after new-session made the pane. A hash, since a companion pane's
//     monitor has read and deleted the token file by then

import {parseResumePaneId} from './program-resume.ts';
import {launchFiles, preparePaneLaunch} from './resume-launch.ts';
import {resumeMonitorCommand} from './resume-monitor.ts';
import {tokenHash} from './resume-records-sqlite.ts';
import {createStateDaos} from './state-daos.ts';
import {buildShellLaunchArgs} from './tmux.ts';

export async function runLaunchVerb(
	verb: 'prepare' | 'commit',
	args: string[],
): Promise<number> {
	const [repo, key, paneArg, ...rest] = args;
	const pane = paneArg ? parseResumePaneId(paneArg) : undefined;
	if (!repo || !key || !pane) return 1;
	const daos = createStateDaos({repo});
	if (verb === 'commit') {
		const [hash] = rest;
		if (!hash) return 1;
		await daos.resumeRecords.commitLaunch(key, pane, hash);
		return 0;
	}
	const [dir, reportExit, command] = rest;
	if (!dir || command === undefined) return 1;
	const launch = preparePaneLaunch(
		{dao: daos.resumeRecords, repo, stateDir: daos.stateDir},
		key,
		pane,
		dir,
	);
	const pipe =
		launch && pane.kind !== 'agent'
			? resumeMonitorCommand({repo, key, launch, dbPath: daos.dbPath})
			: '';
	const argv = buildShellLaunchArgs(
		command,
		reportExit === '1',
		launchFiles(launch),
	);
	process.stdout.write(
		[
			launch?.monitorTokenFile ?? '',
			launch ? tokenHash(launch.token) : '',
			pipe,
			...argv,
		]
			.map(word => `${word}\0`)
			.join(''),
	);
	return 0;
}
