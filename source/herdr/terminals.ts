// Terminals in herdr-core, addressed the way Pappardelle addresses sessions.
//
// A tmux session and an hc terminal are the same idea: a program that keeps
// running with nobody watching. The differences that matter here:
//
//   - hc names are 1-32 of [a-z0-9-_.], so `agent-pappa-chex-STA-313` cannot be
//     a name. The full session name rides on a label instead, and every lookup
//     goes through labels.
//   - hc does not inherit the caller's environment, so a terminal's env is
//     passed explicitly (tmux's `-e K=V` becomes the run call's `env` map).
//   - A terminal has one program, not a shell with panes. The companion's
//     splits are separate terminals, the same as they are separate tmux
//     sessions today.

import {execFileSync} from 'node:child_process';
import {coreClient, isHerdrMissing, HerdrRpcError} from './client.ts';

/** The label carrying a space's full session name, e.g. `agent-pappa-STA-1`. */
export const SESSION_LABEL = 'pappardelle.session';
/** Which half of a space a terminal is: `agent`, `companion` or `split`. */
export const KIND_LABEL = 'pappardelle.kind';
/** The repo, so one core shared by several repos can be swept per repo. */
export const REPO_LABEL = 'pappardelle.repo';
/**
 * The rail whose viewer panes these terminals sit in, as its terminal address.
 *
 * The desktop window gives every pane a terminal of its own, and nothing on the
 * pane says who made it. This label does: it names the rail that split it, so a
 * relaunch finds its own two viewers and leaves the person's own panes alone.
 */
export const VIEWER_LABEL = 'pappardelle.viewer';
/** Which of that rail's viewers a terminal is: `agent` or `companion`. */
export const VIEWER_ROLE_LABEL = 'pappardelle.viewer-role';

export type TerminalFacts = {
	address: string;
	name: string | null;
	cwd: string;
	state: 'live' | 'finished' | string;
	labels: Record<string, string>;
	pid: number | null;
	args: string[];
	exitCode: number | null;
	reason: string | null;
};

type RawTerminal = {
	address: string;
	name?: string | null;
	cwd: string;
	state: string;
	labels?: Record<string, string>;
	pid?: number | null;
	argv?: string[];
	exit_code?: number | null;
	reason?: string | null;
};

function toFacts(raw: RawTerminal): TerminalFacts {
	return {
		address: raw.address,
		name: raw.name ?? null,
		cwd: raw.cwd,
		state: raw.state,
		labels: raw.labels ?? {},
		pid: raw.pid ?? null,
		args: raw.argv ?? [],
		exitCode: raw.exit_code ?? null,
		reason: raw.reason ?? null,
	};
}

/**
 * hc rejects a name that is not 1-32 of [a-z0-9-_.], and refuses one shaped
 * like a terminal address (`t7`). Session names are neither, so they are
 * folded into something legal and kept distinguishable by a short hash.
 */
export function terminalName(sessionName: string): string {
	const slug = sessionName
		.toLowerCase()
		.replaceAll(/[^a-z0-9-_.]/g, '-')
		.replaceAll(/-+/g, '-')
		.replaceAll(/^[-_.]+|[-_.]+$/g, '');

	// A stable, cheap discriminator: two session names can share a slug
	// (`a.b` and `a-b`), and a name that folds to nothing still needs one.
	let hash = 0;
	for (const character of sessionName) {
		// Kept in the unsigned 32-bit range without a bitwise shift, which the
		// lint rules disallow for readability.
		hash = (hash * 31 + character.codePointAt(0)!) % 2 ** 32;
	}

	const suffix = hash.toString(36).slice(0, 6);
	const room = 32 - suffix.length - 1;
	const head = slug.slice(0, room).replaceAll(/[-_.]+$/g, '') || 'pappardelle';
	// A bare `t<digits>` looks like an address and is refused.
	const safeHead = /^t\d+$/.test(head) ? `${head}-s` : head;
	return `${safeHead}-${suffix}`;
}

/** The labels every Pappardelle terminal carries. */
export function terminalLabels(
	sessionName: string,
	kind: 'agent' | 'companion' | 'split',
	repoName: string,
): Record<string, string> {
	return {
		[SESSION_LABEL]: sessionName,
		[KIND_LABEL]: kind,
		[REPO_LABEL]: repoName,
	};
}

export type EnvMap = Record<string, string>;

/**
 * tmux takes env as repeated `-e K=V`; the run call takes a map. The helpers
 * in spawn-env.ts already build the `-e` form, so the pair is folded back into
 * a map here rather than duplicating every caller's list.
 */
export function envArgsToMap(args: readonly string[]): EnvMap {
	const map: EnvMap = {};
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== '-e') continue;
		const pair = args[index + 1];
		if (!pair) continue;
		const split = pair.indexOf('=');
		if (split <= 0) continue;
		map[pair.slice(0, split)] = pair.slice(split + 1);
		index++;
	}

	return map;
}

export type RunTerminalOptions = {
	sessionName: string;
	kind: 'agent' | 'companion' | 'split';
	repoName: string;
	/** Program and arguments, or `line` for a shell command. */
	argv?: string[];
	line?: string;
	cwd: string;
	env?: EnvMap;
	/** Replace a lost program with a shell instead of rerunning it. */
	keep?: boolean;
	/** Initial size, so a program that queries it at start gets a sane answer. */
	size?: {cols: number; rows: number};
	/**
	 * Extra labels. The Herdr desktop app shows a terminal as a pane when it
	 * carries `herdr.space` and `herdr.tab`, so the desktop backend passes them
	 * here.
	 */
	extraLabels?: Record<string, string>;
};

/** Start a terminal, whether or not one already exists (hc refuses a taken name). */
export async function runTerminal(
	options: RunTerminalOptions,
): Promise<TerminalFacts> {
	const params: Record<string, unknown> = {
		name: terminalName(options.sessionName),
		cwd: options.cwd,
		labels: {
			...terminalLabels(options.sessionName, options.kind, options.repoName),
			...options.extraLabels,
		},
		env: options.env ?? {},
		keep: options.keep ?? false,
		// A child of the rail would end with it; a space's program must not.
		no_parent: true,
		// Nothing types notes about these into the user's own terminal.
		no_notify: true,
		outlive_parent: true,
	};

	if (options.argv) params['argv'] = options.argv;
	if (options.line) params['line'] = options.line;
	if (options.size) params['size'] = options.size;

	const raw = await coreClient().call<RawTerminal>('terminal.run', params);
	return toFacts(raw);
}

/** Every live terminal carrying this session's label, or none. */
export async function findTerminals(
	sessionName: string,
	options: {all?: boolean} = {},
): Promise<TerminalFacts[]> {
	const raw = await coreClient().call<{terminals?: RawTerminal[]}>(
		'terminal.list',
		{labels: {[SESSION_LABEL]: sessionName}, all: options.all ?? false},
	);
	return (raw.terminals ?? []).map(terminal => toFacts(terminal));
}

/** Every terminal carrying all of these labels, or none. */
export async function findTerminalsByLabels(
	labels: Record<string, string>,
	options: {all?: boolean} = {},
): Promise<TerminalFacts[]> {
	const raw = await coreClient().call<{terminals?: RawTerminal[]}>(
		'terminal.list',
		{labels, all: options.all ?? false},
	);
	return (raw.terminals ?? []).map(terminal => toFacts(terminal));
}

/** Put a label on a terminal, so a later run can find it again. */
export async function labelTerminal(
	address: string,
	labels: Record<string, string>,
): Promise<boolean> {
	try {
		await coreClient().call('terminal.label', {terminal: address, labels});
		return true;
	} catch (error) {
		if (isHerdrMissing(error)) return false;
		throw error;
	}
}

/** The one terminal a session name names, live or finished, or null. */
export async function findTerminal(
	sessionName: string,
): Promise<TerminalFacts | null> {
	const live = await findTerminals(sessionName).catch(() => []);
	return live[0] ?? null;
}

/** `has-session`: true when the session has a live terminal. */
export async function terminalExists(sessionName: string): Promise<boolean> {
	return (await findTerminal(sessionName)) !== null;
}

/** `kill-session`, addressed by session name. Missing is a success. */
export async function killTerminal(sessionName: string): Promise<boolean> {
	let terminals: TerminalFacts[];
	try {
		terminals = await findTerminals(sessionName, {all: true});
	} catch (error) {
		if (isHerdrMissing(error)) return true;
		throw error;
	}

	for (const terminal of terminals) {
		if (terminal.state === 'live') {
			try {
				await coreClient().call('terminal.kill', {terminal: terminal.address});
			} catch (error) {
				if (!isHerdrMissing(error)) throw error;
				continue;
			}
		}

		// A finished terminal still holds its name, so it is removed whether it
		// just ended or had already ended: recreating the session needs the
		// name back.
		await coreClient()
			.call('terminal.rm', {terminal: terminal.address})
			.catch(() => undefined);
	}

	return true;
}

/** `true` when a program is waiting on an approval or question, so typing at
 * it would answer the dialog rather than reach the agent. */
export function isBlocked(error: unknown): boolean {
	return error instanceof HerdrRpcError && error.kind === 'blocked';
}

/** The live terminal a session name names, or a `not_found` error. */
export async function requireTerminal(
	sessionName: string,
): Promise<TerminalFacts> {
	const terminal = await findTerminal(sessionName);
	if (!terminal) {
		throw new HerdrRpcError(
			'terminal.list',
			'not_found',
			`no live terminal for ${sessionName}`,
		);
	}

	return terminal;
}

/** `send-keys`: paste text and submit it, waiting out a typing person. */
export async function sendText(
	sessionName: string,
	text: string,
	options: {force?: boolean} = {},
): Promise<void> {
	const terminal = await requireTerminal(sessionName);
	await coreClient().call('terminal.send', {
		terminal: terminal.address,
		text,
		force: options.force ?? false,
	});
}

/**
 * `sendKeys`, synchronously, for the callers that run tmux synchronously.
 *
 * `hc keys` takes a terminal name or address, and the CLI owns the socket
 * handshake, so a blocking spawn is enough. A missing terminal reports the
 * same `not_found` kind as the async path.
 */
export function sendKeysSync(
	sessionName: string,
	keys: readonly string[],
): void {
	execFileSync('hc', ['keys', terminalName(sessionName), ...keys], {
		encoding: 'utf8',
		timeout: 5000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

/** Press named keys (`enter`, `esc`, `ctrl+c`) in order. */
export async function sendKeys(
	sessionName: string,
	keys: readonly string[],
): Promise<void> {
	const terminal = await requireTerminal(sessionName);
	await coreClient().call('terminal.keys', {
		terminal: terminal.address,
		keys: [...keys],
	});
}

/** The screen plus `lines` of history, as plain text. */
export async function readScreen(
	sessionName: string,
	lines = 0,
): Promise<string> {
	const terminal = await requireTerminal(sessionName);
	const raw = await coreClient().call<{text?: string}>('terminal.read', {
		terminal: terminal.address,
		lines,
	});
	return raw.text ?? '';
}

/**
 * The screen with its escape sequences kept, for the parsers that read colour
 * or cursor position. hc's read returns text only, so this asks the underlying
 * pane for its ANSI form when the terminal is one herdr is showing; otherwise
 * the plain screen is all there is.
 */
export async function readScreenAnsi(
	sessionName: string,
	lines = 0,
): Promise<string> {
	return readScreen(sessionName, lines);
}

/**
 * Every terminal this repo owns, live or finished. Backs the orphan reapers:
 * a session whose space is gone from the registry is swept from here.
 */
export async function listRepoTerminals(
	repoName: string,
	options: {all?: boolean} = {},
): Promise<TerminalFacts[]> {
	const raw = await coreClient().call<{terminals?: RawTerminal[]}>(
		'terminal.list',
		{labels: {[REPO_LABEL]: repoName}, all: options.all ?? false},
	);
	return (raw.terminals ?? []).map(terminal => toFacts(terminal));
}
