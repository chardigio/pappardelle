import {spawnSync} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import type {OuterTmuxRunner} from './tmux.ts';
import {resolveDisplayVersion, updateShellScript} from './update-check.ts';

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

const TUI_SESSION_PREFIX = 'pappardelle-';

// A live TUI's outer session is `pappardelle-<repo>`, and cli.tsx creates
// ~/.pappardelle/repos/<repo> on startup. Requiring both keeps a user's own
// `pappardelle-*` session off the kill list.
function listRunningTuis(
	tmux: OuterTmuxRunner,
	repoStateRoot: string,
): string[] {
	const result = tmux(['list-sessions', '-F', '#{session_name}']);
	if (result.error || result.status !== 0) return [];

	return result.stdout
		.split('\n')
		.map(name => name.trim())
		.filter(
			name =>
				name.startsWith(TUI_SESSION_PREFIX) &&
				existsSync(
					path.join(repoStateRoot, name.slice(TUI_SESSION_PREFIX.length)),
				),
		);
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
	// goes last.
	const current = deps.currentSession();
	const ordered = [
		...running.filter(name => name !== current),
		...running.filter(name => name === current),
	];
	for (const name of ordered) {
		deps.print(`Quit ${name}`);
		deps.tmux(['kill-session', '-t', name]);
	}

	return 0;
}

// Bare tmux talks to whichever server $TMUX names. From a claude pane that is
// the inner `pappardelle_inner` server, which holds no TUI sessions, so outer
// calls drop TMUX to reach the default server (TMUX_TMPDIR still applies).
export function outerTmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const {TMUX: _tmux, TMUX_PANE: _pane, ...rest} = env;
	return rest;
}

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

// The outer session this process runs in, or null when it runs outside tmux or
// on another server (an inner claude pane, where killing the outer session only
// detaches the client and leaves this process alive).
export function currentOuterSession(
	env: NodeJS.ProcessEnv,
	tmux: OuterTmuxRunner,
): string | null {
	const socket = env['TMUX']?.split(',')[0];
	const pane = env['TMUX_PANE'];
	if (!socket || !pane) return null;

	const uid = process.getuid?.() ?? 0;
	const defaultSocket = path.join(
		env['TMUX_TMPDIR'] || '/tmp',
		`tmux-${uid}`,
		'default',
	);
	if (!sameFile(socket, defaultSocket)) return null;

	const result = tmux(['display-message', '-p', '-t', pane, '#{session_name}']);
	if (result.error || result.status !== 0) return null;
	return result.stdout.trim() || null;
}

const outerTmux: OuterTmuxRunner = args => {
	const r = spawnSync('tmux', [...args], {
		encoding: 'utf8',
		timeout: 5000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: outerTmuxEnv(process.env),
	});
	return {error: r.error, status: r.status, stdout: r.stdout ?? ''};
};

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({input: process.stdin, output: process.stdout});
	try {
		const answer = await rl.question(question);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

export function defaultUpdateCommandDeps(
	pappardelleDir: string,
): UpdateCommandDeps {
	return {
		installedVersion: resolveDisplayVersion(pappardelleDir).version,
		runInstaller() {
			// PAPPARDELLE_NODE hands the installer the node the shim pinned, which
			// PATH may not contain.
			const result = spawnSync(
				'bash',
				['-c', updateShellScript({waitOnFailure: false})],
				{
					stdio: 'inherit',
					env: {...process.env, PAPPARDELLE_NODE: process.execPath},
				},
			);
			return result.status ?? 1;
		},
		tmux: outerTmux,
		repoStateRoot: path.join(homedir(), '.pappardelle', 'repos'),
		currentSession: () => currentOuterSession(process.env, outerTmux),
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		confirm,
		print(line) {
			console.log(line);
		},
	};
}
