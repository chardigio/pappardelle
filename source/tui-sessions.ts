import {existsSync, readdirSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	defaultServerTmuxRunner,
	outerSessionName,
	type OuterTmuxRunner,
	shellQuote,
} from './tmux.ts';
import {readTuiMarker, tryRestartLock, type TuiMarker} from './tui-marker.ts';

// Some tmux releases rewrite `.` and `:` in session names to `_`, so a repo's
// TUI session can carry either spelling.
export function tuiSessionNames(repoName: string): string[] {
	return [
		...new Set([
			outerSessionName(repoName),
			outerSessionName(repoName.replaceAll(/[.:]/g, '_')),
		]),
	];
}

export type RunningTui = {session: string; repo: string};

// cli.tsx creates ~/.pappardelle/repos/<repo> before opening the TUI's
// `pappardelle-<repo>` session, so only sessions named after a state dir are
// TUIs; a user's own `pappardelle-*` session stays off the list.
export function listRunningTuis(
	tmux: OuterTmuxRunner,
	repoStateRoot: string,
): RunningTui[] {
	let repos: string[];
	try {
		repos = readdirSync(repoStateRoot);
	} catch {
		return [];
	}

	// Two repos can claim one session name once tmux's rewriting is allowed
	// for (`my.app` and `my_app`); the repo named exactly like the session wins.
	const repoBySession = new Map([
		...repos.flatMap(repo =>
			tuiSessionNames(repo).map(session => [session, repo] as const),
		),
		...repos.map(repo => [outerSessionName(repo), repo] as const),
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

function tmuxFailure(result: ReturnType<OuterTmuxRunner>): string {
	return (
		result.stderr?.trim() ||
		result.error?.message ||
		`tmux exited ${result.status ?? 'without a status'}`
	);
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
// nothing else reaches the window between them.
export function restartTuiArgs(paneId: string, command: string): string[] {
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
		command,
	];
}

function restartPane(
	paneId: string,
	command: string,
	tmux: OuterTmuxRunner,
): PaneOutcome {
	const result = tmux(restartTuiArgs(paneId, command));
	return result.error || result.status !== 0
		? {ok: false, reason: tmuxFailure(result)}
		: {ok: true, paneId};
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
		const marker = readTuiMarker(deps.repoStateRoot, repo);
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

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
}

// With an `expectedCliPath`, a TUI that comes up on any other cli.js is a
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
			readTuiMarker(deps.repoStateRoot, tui.repo)?.paneId,
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
// each install re-pins to a node meeting that release's floor; baking in the
// launching node would outlive it. Other builds (e.g. a dev build at
// ~/.local/bin/pappardelle-sta862) keep their own node and cli.js so they don't
// fall back to the release.
export function tuiLaunchCommand(options: {
	execPath: string;
	cliPath: string;
	args: string[];
	home: string;
	exists?: (file: string) => boolean;
}): string {
	const exists = options.exists ?? existsSync;
	const releaseCli = path.join(
		options.home,
		'.pappardelle',
		'repo',
		'dist',
		'cli.js',
	);
	const shim = path.join(options.home, '.local', 'bin', 'pappardelle');
	const command =
		path.resolve(options.cliPath) === releaseCli && exists(shim)
			? shellQuote(shim)
			: `${shellQuote(options.execPath)} ${shellQuote(options.cliPath)}`;
	return [command, ...options.args].join(' ');
}

// What a restart runs after an install: the shim the installer just re-pinned,
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

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type RestartOwnTuiDeps = RestartTuiDeps & {
	currentSession: () => string | null;
	killSession: (sessionName: string) => void;
	waitForKey: () => void;
	sleep?: (ms: number) => void;
};

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
		hasPaneLayout: boolean;
	},
	deps: RestartOwnTuiDeps,
): void {
	const current = deps.currentSession();
	if (
		current === null ||
		!tuiSessionNames(options.repoName).includes(current)
	) {
		if (options.hasPaneLayout) {
			deps.killSession(outerSessionName(options.repoName));
		}

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
	deps.killSession(current);
}
