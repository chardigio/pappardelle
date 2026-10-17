import {homedir} from 'node:os';
import path from 'node:path';
import {
	currentDefaultServerSession,
	defaultServerTmuxRunner,
	type OuterTmuxRunner,
} from './tmux.ts';
import {confirm} from './confirm.ts';
import {listRunningTuis, plural, respawnTuis} from './tui-sessions.ts';
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
			`Running Pappardelle TUIs are still on the old build: ${running.join(
				', ',
			)}. Run pappardelle restart in each repo to pick up the update.`,
		);
		return 0;
	}

	respawnTuis(running, deps);
	return 0;
}

export function defaultUpdateCommandDeps(
	pappardelleDir: string,
): UpdateCommandDeps {
	const {version, isDev} = resolveDisplayVersion(pappardelleDir);
	return {
		installedVersion: version && isDev ? `${version}-dev` : version,
		runInstaller: () => runUpdateScript({waitOnFailure: false}),
		tmux: defaultServerTmuxRunner,
		repoStateRoot: path.join(homedir(), '.pappardelle', 'repos'),
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
