import {homedir} from 'node:os';
import path from 'node:path';
import {
	currentDefaultServerSession,
	defaultServerTmuxRunner,
	type OuterTmuxRunner,
} from './tmux.ts';
import {confirm} from './confirm.ts';
import {
	installedLaunchCommand,
	listRunningTuis,
	plural,
	type RestartTiming,
	restartTuis,
} from './tui-sessions.ts';
import {DEFAULT_REPO_STATE_ROOT} from './tui-marker.ts';
import {resolveDisplayVersion, runUpdateScript} from './update-check.ts';

// `pappardelle update`: the CLI twin of pressing U in the TUI. U runs the
// installer and then restarts its own TUI on the new build; from a shell there
// may be several TUIs (one per repo) still on the old build, so the user
// decides whether to restart them.

export type UpdateCommandDeps = {
	installedVersion: string | null;
	runInstaller: () => number;
	tmux: OuterTmuxRunner;
	repoStateRoot: string;
	launchCommand: string;
	timing?: Partial<RestartTiming>;
	currentSession: () => string | null;
	isTTY: boolean;
	confirm: (question: string) => Promise<boolean>;
	print: (line: string) => void;
};

export async function runUpdateCommand(
	options: {restartTuis?: boolean},
	deps: UpdateCommandDeps,
): Promise<number> {
	deps.print(
		deps.installedVersion
			? `Updating Pappardelle (currently on ${deps.installedVersion})...`
			: 'Updating Pappardelle...',
	);

	const status = deps.runInstaller();
	if (status !== 0) return status;

	const running = listRunningTuis(deps.tmux, deps.repoStateRoot);
	if (running.length === 0) return 0;

	const shouldRestart =
		options.restartTuis ??
		(deps.isTTY &&
			(await deps.confirm(
				`Restart ${running.length} running Pappardelle ${plural(
					running.length,
					'TUI',
				)} on the new build? [y/N] `,
			)));

	if (!shouldRestart) {
		deps.print(
			`Running Pappardelle TUIs are still on the old build: ${running
				.map(tui => tui.session)
				.join(
					', ',
				)}. Run pappardelle restart in each repo to pick up the update.`,
		);
		return 0;
	}

	const failed = await restartTuis(running, deps.launchCommand, deps);
	if (failed.length === 0) return 0;
	deps.print(
		`Pappardelle is updated, but ${failed.join(', ')} ${
			failed.length === 1 ? 'is' : 'are'
		} not confirmed on the new build. Quit with q and relaunch.`,
	);
	return 1;
}

export function defaultUpdateCommandDeps(
	pappardelleDir: string,
): UpdateCommandDeps {
	const {version, isDev} = resolveDisplayVersion(pappardelleDir);
	return {
		installedVersion: version && isDev ? `${version}-dev` : version,
		runInstaller: () => runUpdateScript({waitOnFailure: false}),
		tmux: defaultServerTmuxRunner,
		repoStateRoot: DEFAULT_REPO_STATE_ROOT,
		launchCommand: installedLaunchCommand({
			execPath: process.execPath,
			cliPath: path.resolve(process.argv[1] ?? ''),
			home: homedir(),
		}),
		currentSession: () => currentDefaultServerSession(process.env),
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		async confirm(question) {
			return confirm(question);
		},
		print(line) {
			console.log(line);
		},
	};
}
