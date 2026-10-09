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
	respawnTuiArgs,
	respawnTuis,
	tuiSessionNames,
} from './tui-sessions.ts';
import {confirm} from './confirm.ts';

// `pappardelle restart` respawns this repo's TUI window in place.
// `pappardelle restart --hard` also ends every agent/companion session (the
// inner tmux server); each agent resumes its own conversation the next time
// its space is selected.

export type RestartCommandDeps = {
	tmux: OuterTmuxRunner;
	innerTmux: OuterTmuxRunner;
	repoStateRoot: string;
	currentSession: () => string | null;
	onInnerServer: boolean;
	inTmux: boolean;
	attach: (sessionName: string) => number;
	runDetached: (steps: string[][]) => void;
	isTTY: boolean;
	confirm: (question: string) => Promise<boolean>;
	print: (line: string) => void;
};

export function restartRepo(
	repoName: string,
	deps: RestartCommandDeps,
): number {
	const candidates = new Set(tuiSessionNames(repoName));
	const name = listRunningTuis(deps.tmux, deps.repoStateRoot).find(session =>
		candidates.has(session),
	);
	if (!name) {
		deps.print(
			`No running Pappardelle TUI for ${repoName}. Start one with pappardelle.`,
		);
		return 0;
	}

	if (respawnTuis([name], deps).length > 0) return 1;
	return deps.inTmux ? 0 : deps.attach(name);
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
				'restart --hard needs --yes when not run from a terminal; it ends every agent session.',
			);
			return 1;
		}

		const restartPart =
			running.length === 0
				? ''
				: ` and restart ${running.length} ${plural(
						running.length,
						'TUI',
					)} (${running.join(', ')})`;
		const ok = await deps.confirm(
			`End ${innerCount} agent/companion ${plural(
				innerCount,
				'session',
			)} (agents resume their conversations)${restartPart}? [y/N] `,
		);
		if (!ok) return 0;
	}

	// The inner server dies before any TUI restarts. A TUI respawned first could
	// attach its viewers to the old sessions, and its cached selection would
	// then keep the dead viewers on screen after the kill.
	if (deps.onInnerServer) {
		// Killing the inner server ends this process, so a detached child runs
		// the kill and the respawns.
		deps.print(
			`Ending agent sessions and restarting ${running.length} ${plural(
				running.length,
				'TUI',
			)}...`,
		);
		deps.runDetached([
			innerTmuxArgs(['kill-server']),
			...running.map(name => respawnTuiArgs(name)),
		]);
		return 0;
	}

	deps.innerTmux(['kill-server']);
	return respawnTuis(running, deps).length > 0 ? 1 : 0;
}

export function defaultRestartCommandDeps(): RestartCommandDeps {
	return {
		tmux: defaultServerTmuxRunner,
		innerTmux: defaultInnerTmuxRunner,
		repoStateRoot: path.join(homedir(), '.pappardelle', 'repos'),
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
