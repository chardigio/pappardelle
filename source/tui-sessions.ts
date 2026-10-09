import {readdirSync} from 'node:fs';
import {
	defaultServerTmuxRunner,
	outerSessionName,
	type OuterTmuxRunner,
} from './tmux.ts';

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

// cli.tsx creates ~/.pappardelle/repos/<repo> before opening the TUI's
// `pappardelle-<repo>` session, so only sessions named after a state dir are
// TUIs; a user's own `pappardelle-*` session stays off the list.
export function listRunningTuis(
	tmux: OuterTmuxRunner,
	repoStateRoot: string,
): string[] {
	const result = tmux(['list-sessions', '-F', '#{session_name}']);
	if (result.error || result.status !== 0) return [];

	let repos: string[];
	try {
		repos = readdirSync(repoStateRoot);
	} catch {
		return [];
	}

	const names = new Set(repos.flatMap(repo => tuiSessionNames(repo)));
	return result.stdout
		.split('\n')
		.map(name => name.trim())
		.filter(name => names.has(name));
}

// `=name:` is an exact session match (a bare name falls back to prefix
// matching and reads `.` as a pane separator), and `^` is the session's
// lowest-numbered window, where new-session put the TUI. Without it tmux picks
// whichever window is selected.
export function respawnTuiArgs(sessionName: string): string[] {
	return ['respawn-window', '-k', '-t', `=${sessionName}:^`];
}

// Reruns the TUI window's original command, so the terminal stays attached and
// the layout rebuilds on whatever build that command now points at.
export function respawnTuiWindow(
	sessionName: string,
	tmux: OuterTmuxRunner = defaultServerTmuxRunner,
): boolean {
	const result = tmux(respawnTuiArgs(sessionName));
	return !result.error && result.status === 0;
}

// Respawning the session this process runs in ends this process, so it goes
// last.
export function orderCurrentLast(
	names: string[],
	current: string | null,
): string[] {
	return [
		...names.filter(name => name !== current),
		...names.filter(name => name === current),
	];
}

// Returns the sessions tmux refused to respawn.
export function respawnTuis(
	names: string[],
	deps: {
		tmux: OuterTmuxRunner;
		currentSession: () => string | null;
		print: (line: string) => void;
	},
): string[] {
	const failed: string[] = [];
	for (const name of orderCurrentLast(names, deps.currentSession())) {
		deps.print(`Restarting ${name}`);
		if (!respawnTuiWindow(name, deps.tmux)) {
			deps.print(`Couldn't restart ${name}; quit it with q and relaunch it`);
			failed.push(name);
		}
	}

	return failed;
}
