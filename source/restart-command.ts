import {spawn, spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {
	currentDefaultServerSession,
	defaultInnerTmuxRunner,
	defaultServerTmuxEnv,
	defaultServerTmuxRunner,
	innerTmuxArgs,
	isInTmux,
	isOnInnerServer,
	type OuterTmuxRunner,
	shellQuote,
} from './tmux.ts';
import {
	listRunningTuis,
	listSessionNames,
	plural,
	restartAndVerifyTui,
	restartTuiArgs,
	restartTuis,
	type RestartTiming,
	tuiLaunchCommand,
	tuiListPane,
} from './tui-sessions.ts';
import {DEFAULT_REPO_STATE_ROOT} from './tui-marker.ts';
import {confirm} from './confirm.ts';

// `pappardelle restart` reruns this repo's TUI in its pane, on the build that
// ran the command, and waits for it to report ready.
// `pappardelle restart --hard` also ends every Claude/companion session (the
// inner tmux server); they come back with `claude --continue` the next time a
// space is selected.

export type RestartCommandDeps = {
	tmux: OuterTmuxRunner;
	innerTmux: OuterTmuxRunner;
	repoStateRoot: string;
	launchCommand: string;
	cliPath: string;
	timing?: Partial<RestartTiming>;
	currentSession: () => string | null;
	onInnerServer: boolean;
	inTmux: boolean;
	attach: (sessionName: string) => number;
	runDetached: (steps: string[][]) => void;
	isTTY: boolean;
	confirm: (question: string) => Promise<boolean>;
	print: (line: string) => void;
};

export async function restartRepo(
	repoName: string,
	deps: RestartCommandDeps,
): Promise<number> {
	const tui = listRunningTuis(deps.tmux, deps.repoStateRoot).find(
		running => running.repo === repoName,
	);
	if (!tui) {
		deps.print(
			`No running Pappardelle TUI for ${repoName}. Start one with pappardelle.`,
		);
		return 0;
	}

	if (!(await restartAndVerifyTui(tui, deps.launchCommand, deps.cliPath, deps)))
		return 1;
	return deps.inTmux ? 0 : deps.attach(tui.session);
}

export async function hardRestart(
	yes: boolean,
	deps: RestartCommandDeps,
): Promise<number> {
	const running = listRunningTuis(deps.tmux, deps.repoStateRoot);
	const innerCount = listSessionNames(deps.innerTmux).length;

	if (!yes) {
		if (!deps.isTTY) {
			deps.print(
				'restart --hard needs --yes when not run from a terminal; it ends every Claude session.',
			);
			return 1;
		}

		const restartPart =
			running.length === 0
				? ''
				: ` and restart ${running.length} ${plural(
						running.length,
						'TUI',
					)} (${running.map(tui => tui.session).join(', ')})`;
		const ok = await deps.confirm(
			`End ${innerCount} Claude/companion ${plural(
				innerCount,
				'session',
			)} (they resume with --continue)${restartPart}? [y/N] `,
		);
		if (!ok) return 0;
	}

	// The inner server dies before any TUI restarts. A TUI respawned first could
	// attach its viewers to the old sessions, and its cached selection would
	// then keep the dead viewers on screen after the kill.
	if (deps.onInnerServer) {
		// Killing the inner server ends this process, so a detached child runs
		// the kill and the restarts, and nothing is left to confirm them.
		const restarts: string[][] = [];
		for (const tui of running) {
			const pane = tuiListPane(tui.session, deps.tmux);
			if (pane.ok) {
				restarts.push(restartTuiArgs(pane.paneId, deps.launchCommand));
			} else {
				deps.print(`Couldn't restart ${tui.session}: ${pane.reason}`);
			}
		}

		deps.print(
			`Ending Claude sessions and restarting ${restarts.length} ${plural(
				restarts.length,
				'TUI',
			)}...`,
		);
		deps.runDetached([innerTmuxArgs(['kill-server']), ...restarts]);
		return restarts.length === running.length ? 0 : 1;
	}

	deps.innerTmux(['kill-server']);
	const failed = await restartTuis(running, deps.launchCommand, deps);
	return failed.length > 0 ? 1 : 0;
}

export function defaultRestartCommandDeps(): RestartCommandDeps {
	const cliPath = path.resolve(process.argv[1] ?? '');
	return {
		tmux: defaultServerTmuxRunner,
		innerTmux: defaultInnerTmuxRunner,
		repoStateRoot: DEFAULT_REPO_STATE_ROOT,
		launchCommand: tuiLaunchCommand({
			execPath: process.execPath,
			cliPath,
			args: [],
			home: homedir(),
		}),
		cliPath,
		currentSession: () => currentDefaultServerSession(process.env),
		onInnerServer: isOnInnerServer(process.env),
		inTmux: isInTmux(),
		attach(sessionName) {
			const result = spawnSync(
				'tmux',
				['attach-session', '-t', `=${sessionName}:`],
				{
					stdio: 'inherit',
				},
			);
			return result.status ?? 1;
		},
		runDetached(steps) {
			const script = steps
				.map(argv => ['tmux', ...argv].map(arg => shellQuote(arg)).join(' '))
				.join('; ');
			spawn('/bin/sh', ['-c', script], {
				detached: true,
				stdio: 'ignore',
				env: defaultServerTmuxEnv(process.env),
			}).unref();
		},
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		async confirm(question) {
			return confirm(question);
		},
		print(line) {
			console.log(line);
		},
	};
}
