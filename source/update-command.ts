import {readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import type {Readable, Writable} from 'node:stream';
import {
	currentDefaultServerSession,
	defaultServerTmuxRunner,
	outerSessionName,
	type OuterTmuxRunner,
} from './tmux.ts';
import {resolveDisplayVersion, runUpdateScript} from './update-check.ts';

// `pappardelle update`: the CLI twin of pressing U in the TUI. U runs the
// installer and then kills its own outer session so the old build stops; from
// a shell there may be several TUIs (one per repo) still on the old build, so
// the user decides whether to quit them.

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

// cli.tsx creates ~/.pappardelle/repos/<repo> before opening the TUI's
// `pappardelle-<repo>` session, so only sessions named after a state dir are
// TUIs; a user's own `pappardelle-*` session stays off the kill list. Some tmux
// releases rewrite `.` and `:` in session names to `_`, so both spellings
// count.
function listRunningTuis(
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

	const tuiNames = new Set(
		repos.flatMap(repo => [
			outerSessionName(repo),
			outerSessionName(repo.replaceAll(/[.:]/g, '_')),
		]),
	);
	return result.stdout
		.split('\n')
		.map(name => name.trim())
		.filter(name => tuiNames.has(name));
}

export async function runUpdateCommand(
	options: {killTuis?: boolean},
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

	const shouldKill =
		options.killTuis ??
		(deps.isTTY &&
			(await deps.confirm(
				`Quit ${running.length} running Pappardelle TUI${
					running.length === 1 ? '' : 's'
				} so they pick up the update? [y/N] `,
			)));

	if (!shouldKill) {
		deps.print(
			`Running Pappardelle TUIs are still on the old build: ${running.join(
				', ',
			)}. Quit (q) and relaunch them to pick up the update.`,
		);
		return 0;
	}

	// Killing the session this command runs in hangs up on this process, so it
	// goes last and its line prints before the kill.
	const current = deps.currentSession();
	const ordered = [
		...running.filter(name => name !== current),
		...running.filter(name => name === current),
	];
	for (const name of ordered) {
		deps.print(`Quitting ${name}`);
		// `=name:` is an exact session match. A bare name falls back to prefix
		// matching (a vanished `pappardelle-app` would hit `pappardelle-apple`)
		// and reads a `.` as a pane separator.
		const killed = deps.tmux(['kill-session', '-t', `=${name}:`]);
		if (killed.error || killed.status !== 0) {
			deps.print(`Couldn't quit ${name}; quit it with q and relaunch it`);
		}
	}

	return 0;
}

// Ctrl+D or a closed stdin at the prompt means "no", not a crash: the install
// already succeeded.
export async function confirm(
	question: string,
	input: Readable = process.stdin,
	output: Writable = process.stdout,
): Promise<boolean> {
	const rl = createInterface({input, output});
	const closed = new Promise<string>(resolve => {
		rl.once('close', () => {
			resolve('');
		});
	});
	try {
		const answer = await Promise.race([rl.question(question), closed]);
		return /^y(es)?$/i.test(answer.trim());
	} catch {
		return false;
	} finally {
		rl.close();
	}
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
