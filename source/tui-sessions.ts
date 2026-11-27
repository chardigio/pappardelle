import {bunIsolationArgs} from './runtime.ts';
import {existsSync} from 'node:fs';
import {sameFile} from './same-file.ts';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	clearSousChefKeyArgs,
	defaultServerTmuxRunner,
	OUTER_SESSION_PREFIX,
	outerDetachOnDestroyArgs,
	outerSessionName,
	sleepSync,
	tmuxFailure,
	type OuterTmuxRunner,
} from './tmux.ts';
import {shellQuote} from './shell-quote.ts';
import {tmuxFormatLiteral} from './tmux-format.ts';
import type {PaneLayout} from './types.ts';
import {
	tryRestartLock,
	type TuiMarker,
	type TuiMarkerDao,
} from './tui-marker.ts';

// A TUI started before outer session names were spelled with tmuxSessionRepo
// runs under the repo's own spelling until it quits.
export function tuiSessionNames(repoName: string): string[] {
	return [
		...new Set([outerSessionName(repoName), repoSpelledOuterName(repoName)]),
	];
}

function repoSpelledOuterName(repoName: string): string {
	return `${OUTER_SESSION_PREFIX}${repoName}`;
}

export type RunningTui = {session: string; repo: string};

// cli.tsx creates ~/.pappardelle/repos/<repo> before opening the TUI's
// `pappardelle-<repo>` session, so only sessions named after a state dir are
// TUIs; a user's own `pappardelle-*` session stays off the list.
export function listRunningTuis(
	tmux: OuterTmuxRunner,
	repos: string[],
): RunningTui[] {
	// Two repos can claim one session name once tmux's rewriting is allowed
	// for (`my.app` and `my_app`); the repo named exactly like the session wins.
	const repoBySession = new Map([
		...repos.flatMap(repo =>
			tuiSessionNames(repo).map(session => [session, repo] as const),
		),
		...repos.map(repo => [repoSpelledOuterName(repo), repo] as const),
	]);
	return listSessionNames(tmux).flatMap(session => {
		const repo = repoBySession.get(session);
		return repo === undefined ? [] : [{session, repo}];
	});
}

// An unreachable server (none running, or tmux missing) has no sessions.
export function listSessionNames(tmux: OuterTmuxRunner): string[] {
	const result = tmux(['list-sessions', '-F', '#{session_name}']);
	if (result.error || result.status !== 0) return [];
	return result.stdout
		.split('\n')
		.map(name => name.trim())
		.filter(Boolean);
}

export function plural(count: number, word: string): string {
	return count === 1 ? word : `${word}s`;
}

type PaneOutcome = {ok: true; paneId: string} | {ok: false; reason: string};

// The pane the TUI itself runs in. `=name:` is an exact session match (a bare
// name falls back to prefix matching and reads `.` as a pane separator), and
// `^` is the session's lowest-numbered window, where new-session put the TUI.
// The TUI's ready marker names its pane; the user may have swapped panes
// since. Without a marker for a pane still in that window (a TUI from before
// markers existed), the first pane is the best guess: the viewers are split
// off the TUI's pane.
export function tuiListPane(
	sessionName: string,
	tmux: OuterTmuxRunner = defaultServerTmuxRunner,
	markerPaneId: string | null = null,
): PaneOutcome {
	const result = tmux([
		'list-panes',
		'-t',
		`=${sessionName}:^`,
		'-F',
		'#{pane_id}',
	]);
	if (result.error || result.status !== 0) {
		return {ok: false, reason: tmuxFailure(result)};
	}

	const panes = result.stdout
		.split('\n')
		.map(pane => pane.trim())
		.filter(Boolean);
	const paneId =
		markerPaneId !== null && panes.includes(markerPaneId)
			? markerPaneId
			: panes[0];
	return paneId
		? {ok: true, paneId}
		: {ok: false, reason: `${sessionName} has no panes`};
}

// Closes the viewer panes and reruns the TUI in its own pane, so the terminal
// stays attached and the layout rebuilds. `respawn-window -k` would do both in
// one step, but on tmux next-3.9 it kills the whole server when the window has
// several panes and a client attached. Both commands go in one invocation so
// nothing else reaches the window between them. The pane kept can be a
// viewer started elsewhere, so the TUI is started in `cwd`, a tmux -c value:
// by default the session's own directory.
export function restartTuiArgs(
	paneId: string,
	command: string,
	start: {cwd?: string; envArgs?: readonly string[]} = {},
): string[] {
	return [
		'kill-pane',
		'-a',
		'-t',
		paneId,
		';',
		'respawn-pane',
		'-k',
		'-t',
		paneId,
		'-c',
		start.cwd ?? '#{session_path}',
		...(start.envArgs ?? []),
		command,
	];
}

function restartPane(
	paneId: string,
	command: string,
	tmux: OuterTmuxRunner,
	start: {cwd?: string; envArgs?: readonly string[]} = {},
): PaneOutcome {
	const result = tmux(restartTuiArgs(paneId, command, start));
	return result.error || result.status !== 0
		? {ok: false, reason: tmuxFailure(result)}
		: {ok: true, paneId};
}

/**
 * Rerun a TUI that died in its session's pane, in `cwd`, the directory it is
 * launched from: the one the session was created in may be a closed space's
 * worktree. Killing the session and creating it again can empty the server,
 * and a client that reaches a server on its way out ends with it.
 */
export function reviveTui(
	revival: {
		session: string;
		command: string;
		cwd: string;
		envArgs: readonly string[];
		markerPaneId: string | null;
	},
	tmux: OuterTmuxRunner = defaultServerTmuxRunner,
): PaneOutcome {
	const pane = tuiListPane(revival.session, tmux, revival.markerPaneId);
	return pane.ok
		? restartPane(pane.paneId, revival.command, tmux, {
				cwd: tmuxFormatLiteral(revival.cwd),
				envArgs: revival.envArgs,
			})
		: pane;
}

function lockRefusal(lock: {holder: number | null; error?: string}): string {
	if (lock.error !== undefined) return lock.error;
	return lock.holder === null
		? 'another restart is still running'
		: `another restart (pid ${lock.holder}) is still running`;
}

// Respawning the session this process runs in may end this process (when it
// runs in the TUI's window), so it goes last.
export function orderCurrentLast<T>(
	items: T[],
	isCurrent: (item: T) => boolean,
): T[] {
	return [
		...items.filter(item => !isCurrent(item)),
		...items.filter(item => isCurrent(item)),
	];
}

export type RestartTiming = {
	lockTimeoutMs: number;
	readyTimeoutMs: number;
	pollMs: number;
};

const DEFAULT_RESTART_TIMING: RestartTiming = {
	lockTimeoutMs: 20_000,
	readyTimeoutMs: 15_000,
	pollMs: 100,
};

export type RestartTuiDeps = {
	tmux: OuterTmuxRunner;
	repoStateRoot: string;
	/** The ready marker of a repo's TUI. */
	tuiMarker: (repo: string) => Pick<TuiMarkerDao, 'read'>;
	print: (line: string) => void;
	timing?: Partial<RestartTiming>;
};

type Ready =
	| {status: 'ready'; marker: TuiMarker}
	| {status: 'exited'}
	| {status: 'timeout'};

async function waitForTuiMarker(
	{repo, paneId, since}: {repo: string; paneId: string; since: number},
	deps: RestartTuiDeps,
	timing: RestartTiming,
): Promise<Ready> {
	const deadline = Date.now() + timing.readyTimeoutMs;
	for (;;) {
		const marker = deps.tuiMarker(repo).read();
		if (marker && marker.paneId === paneId && marker.startedAt >= since) {
			return {status: 'ready', marker};
		}

		const pane = deps.tmux([
			'display-message',
			'-p',
			'-t',
			paneId,
			'#{pane_dead}',
		]);
		if (pane.error || pane.status !== 0 || pane.stdout.trim() === '1') {
			return {status: 'exited'};
		}

		if (Date.now() >= deadline) return {status: 'timeout'};
		await delay(timing.pollMs);
	}
}

// With an `expectedCliPath`, a TUI that comes up on any other build is a
// failure. Returns whether the TUI is confirmed running.
export async function restartAndVerifyTui(
	tui: RunningTui,
	command: string,
	expectedCliPath: string | null,
	deps: RestartTuiDeps,
): Promise<boolean> {
	const timing = {...DEFAULT_RESTART_TIMING, ...deps.timing};
	const lockDeadline = Date.now() + timing.lockTimeoutMs;
	let lock = tryRestartLock(deps.repoStateRoot, tui.repo);
	while (!lock.held) {
		if (lock.error !== undefined || Date.now() >= lockDeadline) {
			deps.print(`Couldn't restart ${tui.session}: ${lockRefusal(lock)}`);
			return false;
		}

		await delay(timing.pollMs);
		lock = tryRestartLock(deps.repoStateRoot, tui.repo);
	}

	try {
		deps.print(`Restarting ${tui.session}`);
		const since = Date.now();
		const pane = tuiListPane(
			tui.session,
			deps.tmux,
			deps.tuiMarker(tui.repo).read()?.paneId,
		);
		const restarted = pane.ok
			? restartPane(pane.paneId, command, deps.tmux)
			: pane;
		if (!restarted.ok) {
			deps.print(`Couldn't restart ${tui.session}: ${restarted.reason}`);
			return false;
		}

		const ready = await waitForTuiMarker(
			{repo: tui.repo, paneId: restarted.paneId, since},
			deps,
			timing,
		);
		if (ready.status === 'exited') {
			deps.print(
				`${tui.session} exited during startup; see ~/.pappardelle/logs`,
			);
			return false;
		}

		if (ready.status === 'timeout') {
			deps.print(
				`${tui.session} did not report ready within ${Math.round(
					timing.readyTimeoutMs / 1000,
				)}s`,
			);
			return false;
		}

		const {cliPath, sha} = ready.marker;
		if (expectedCliPath !== null && !sameFile(cliPath, expectedCliPath)) {
			deps.print(
				`${tui.session} is running ${cliPath}, not ${expectedCliPath}`,
			);
			return false;
		}

		deps.print(`${tui.session} is running ${cliPath} (${sha})`);
		return true;
	} finally {
		lock.release();
	}
}

// Returns the sessions that are not confirmed running after their restart.
export async function restartTuis(
	tuis: RunningTui[],
	command: string,
	deps: RestartTuiDeps & {currentSession: () => string | null},
): Promise<string[]> {
	const current = deps.currentSession();
	const failed: string[] = [];
	for (const tui of orderCurrentLast(tuis, tui => tui.session === current)) {
		// One at a time: restarting the current session may end this process.
		if (!(await restartAndVerifyTui(tui, command, null, deps))) {
			failed.push(tui.session);
		}
	}

	return failed;
}

// The command a new TUI session runs, which every later restart reruns. A TUI
// started from the installed release runs through the ~/.local/bin shim, which
// each install rewrites to run that install's executable, so a restart follows
// a later local install instead of staying on the release. Other builds (e.g. a
// dev build at ~/.local/bin/pappardelle-sta862, or a source run) keep their own
// command so they don't fall back to the release.
export function tuiLaunchCommand(options: {
	execPath: string;
	cliPath: string;
	args: string[];
	home: string;
	exists?: (file: string) => boolean;
}): string {
	const exists = options.exists ?? existsSync;
	const releaseExecutable = path.join(
		options.home,
		'.pappardelle',
		'repo',
		'dist',
		'pappardelle',
	);
	const shim = path.join(options.home, '.local', 'bin', 'pappardelle');
	const command =
		path.resolve(options.cliPath) === releaseExecutable && exists(shim)
			? shellQuote(shim)
			: options.execPath === options.cliPath
				? shellQuote(options.execPath)
				: [options.execPath, ...bunIsolationArgs, options.cliPath]
						.map(arg => shellQuote(arg))
						.join(' ');
	return [command, ...options.args].join(' ');
}

// What a restart runs after an install: the shim the installer just rewrote,
// or this build when there is no shim.
export function installedLaunchCommand(options: {
	execPath: string;
	cliPath: string;
	home: string;
	exists?: (file: string) => boolean;
}): string {
	const exists = options.exists ?? existsSync;
	const shim = path.join(options.home, '.local', 'bin', 'pappardelle');
	return exists(shim)
		? shellQuote(shim)
		: tuiLaunchCommand({...options, args: []});
}

export type CloseLayoutDeps = {
	currentSession: () => string | null;
	killSession: (sessionName: string) => void;
	// Reaches the server the layout was split on, which is the one $TMUX names.
	layoutTmux: OuterTmuxRunner;
	/** The panes showing the companion's splits, which come and go with the space. */
	splitPanes: () => string[];
};

export type RestartOwnTuiDeps = Omit<RestartTuiDeps, 'tuiMarker'> &
	CloseLayoutDeps & {
		waitForKey: () => void;
		sleep?: (ms: number) => void;
	};

function isOwnTuiSession(
	repoName: string,
	session: string | null,
): session is string {
	return session !== null && tuiSessionNames(repoName).includes(session);
}

// A session made by an older build, which a restart keeps, has no
// detach-on-destroy of its own.
function closeOwnSession(session: string, deps: CloseLayoutDeps): void {
	deps.layoutTmux(outerDetachOnDestroyArgs(session));
	deps.killSession(session);
}

// One call per pane: tmux skips the rest of a command list after a failure,
// so a viewer the user already closed would keep the other one open.
function closeViewerPanes(layout: PaneLayout, deps: CloseLayoutDeps): void {
	for (const paneId of [
		layout.agentViewerPaneId,
		layout.companionViewerPaneId,
		...deps.splitPanes(),
	])
		if (paneId) deps.layoutTmux(['kill-pane', '-t', paneId]);
	deps.layoutTmux(clearSousChefKeyArgs(layout.listPaneId));
}

// Quitting takes the TUI's own session down with it. A TUI started inside the
// user's own tmux session closes just the viewers it split off: left open,
// they keep the rail pane narrow, and the next run there splits the rail into
// a second layout.
export function closeTuiLayout(
	repoName: string,
	layout: PaneLayout,
	deps: CloseLayoutDeps,
): void {
	const current = deps.currentSession();
	if (isOwnTuiSession(repoName, current)) closeOwnSession(current, deps);
	else closeViewerPanes(layout, deps);
}

// `pappardelle restart` reruns the TUI with `respawn-pane -k`, which hangs up
// the one running there. If that TUI closed its layout, it would kill the
// session its replacement just started in.
export function paneRespawned(
	paneId: string,
	startedPid: string,
	tmux: OuterTmuxRunner,
): boolean {
	const result = tmux(['display-message', '-p', '-t', paneId, '#{pane_pid}']);
	const pid = result.stdout.trim();
	return (
		!result.error && result.status === 0 && pid !== '' && pid !== startedPid
	);
}

// The TUI restarting itself after U's install. A successful restart ends this
// process, so nothing after it runs and the lock it leaves is stale at once.
// Only this TUI's own session qualifies: another terminal may run the same
// repo's TUI, and a TUI started inside the user's own tmux session has no pane
// to rerun, so that one closes its layout instead.
//
// When the restart is refused, the session is closed once the user has read
// why: left open it would hold only the viewers, and the next `pappardelle`
// would attach to it instead of starting a TUI.
export function restartOwnTui(
	options: {
		repoName: string;
		paneId: string;
		command: string;
		paneLayout: PaneLayout | null;
	},
	deps: RestartOwnTuiDeps,
): void {
	const current = deps.currentSession();
	if (!isOwnTuiSession(options.repoName, current)) {
		if (options.paneLayout) closeViewerPanes(options.paneLayout, deps);
		return;
	}

	const timing = {...DEFAULT_RESTART_TIMING, ...deps.timing};
	const sleep = deps.sleep ?? sleepSync;
	const deadline = Date.now() + timing.lockTimeoutMs;
	let lock = tryRestartLock(deps.repoStateRoot, options.repoName);
	while (!lock.held && lock.error === undefined && Date.now() < deadline) {
		sleep(timing.pollMs);
		lock = tryRestartLock(deps.repoStateRoot, options.repoName);
	}

	const result: PaneOutcome = lock.held
		? restartPane(options.paneId, options.command, deps.tmux)
		: {ok: false, reason: lockRefusal(lock)};
	if (result.ok) return;
	if (lock.held) lock.release();
	deps.print(
		`Couldn't restart: ${result.reason}. Relaunch with pappardelle.\nPress any key to close.`,
	);
	deps.waitForKey();
	closeOwnSession(current, deps);
}
