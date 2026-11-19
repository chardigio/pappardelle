// The Herdr desktop app (`herdr-app`): the window that shows spaces, tabs and
// panes, and arranges the terminals herdr-core runs.
//
// It is a third program, distinct from the two already handled:
//
//   - herdr-core (`hc`) runs the terminals. It has a socket and many requests
//     per connection, so terminals.ts talks to it directly.
//   - `herdr` is the older terminal multiplexer. Its server answers one request
//     per connection, so layout.ts drives it through the CLI.
//   - `herdr-app` is this: a GUI window. Every change goes through `herdr-app
//     do <command>`, which prints one JSON document, and `herdr-app ls` reads
//     the current window's spaces, tabs and panes.
//
// What matters for Pappardelle is the pane model. In the app a pane *is* a
// terminal: it is not a viewer that attaches to one. A new pane is
// `pane.split`, and its new terminal is chosen by `argv`. Unlike the CLI's
// panes, `terminal.show` does not repoint a pane at another terminal, so a
// pane's terminal is fixed once made.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 20_000;

/** A failure the app reported, keeping the message it gave. */
export class HerdrAppError extends Error {
	readonly args: readonly string[];

	constructor(args: readonly string[], message: string) {
		super(`herdr-app ${args.join(' ')} failed: ${message}`);
		this.name = 'HerdrAppError';
		this.args = args;
	}
}

/**
 * Run one `herdr-app` invocation and return its parsed JSON.
 *
 * `do` prints `{ "space", "tab", "terminal" }` or `{ "pane", "terminal" }`, and
 * `{ "error": "..." }` with a non-zero exit on failure. `ls` and `status`
 * print one object either way.
 */
async function runHerdrApp(
	args: readonly string[],
): Promise<Record<string, unknown>> {
	let stdout = '';
	let stderr = '';
	let failed = false;

	try {
		const result = await execFileAsync('herdr-app', [...args], {
			timeout: CLI_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			encoding: 'utf8',
		});
		stdout = result.stdout;
	} catch (error) {
		const shaped = error as {
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		stdout = shaped.stdout ?? '';
		stderr = shaped.stderr ?? '';
		failed = true;
		if (!stdout.trim()) {
			throw new HerdrAppError(
				args,
				stderr.trim() || (shaped.message ?? 'no output'),
			);
		}
	}

	const body = parseJson(stdout);
	if (body === null) {
		if (failed) throw new HerdrAppError(args, stderr.trim() || 'no output');
		throw new HerdrAppError(
			args,
			`unparseable output: ${stdout.slice(0, 200)}`,
		);
	}

	if (typeof body['error'] === 'string') {
		throw new HerdrAppError(args, body['error']);
	}

	return body;
}

/** The last JSON document printed, which is the command's answer. */
function parseJson(stdout: string): Record<string, unknown> | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		// A `do` that printed a leading line still ends with one document.
		const start = trimmed.indexOf('{');
		if (start === -1) return null;
		try {
			return JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
}

/** `herdr-app do <command>` with name/value arguments. */
export async function doCommand(
	command: string,
	args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const flags: string[] = [];
	for (const [name, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		flags.push(
			`--${name}`,
			typeof value === 'string' ? value : JSON.stringify(value),
		);
	}

	return runHerdrApp(['do', command, ...flags]);
}

export type AppSpace = {
	id: string;
	name: string;
	folder: string | null;
	machine: string | null;
	active: boolean;
	tabs: AppTab[];
};

export type AppTab = {
	id: string;
	name: string;
	active: boolean;
	settled: boolean;
	terminals: AppTerminal[];
};

export type AppTerminal = {
	terminal: string;
	pane: string;
	status: string | null;
	app: string | null;
	name: string | null;
};

/** `herdr-app ls`: every space in the open window, with its tabs and panes. */
export async function listSpaces(): Promise<AppSpace[]> {
	const body = await runHerdrApp(['ls']);
	const spaces = (body['spaces'] as AppSpace[] | undefined) ?? [];
	return spaces.map(space => ({
		id: space.id,
		name: space.name,
		folder: space.folder ?? null,
		machine: space.machine ?? null,
		active: space.active ?? false,
		tabs: (space.tabs ?? []).map(tab => ({
			id: tab.id,
			name: tab.name,
			active: tab.active ?? false,
			settled: tab.settled ?? false,
			terminals: (tab.terminals ?? []).map(terminal => ({
				terminal: terminal.terminal,
				pane: terminal.pane,
				status: terminal.status ?? null,
				app: terminal.app ?? null,
				name: terminal.name ?? null,
			})),
		})),
	}));
}

/** `herdr-app status`: what the window is showing. */
export async function appStatus(): Promise<Record<string, unknown>> {
	return runHerdrApp(['status']);
}

/**
 * `true` when the desktop app answers. A window that is not running has no
 * socket, which is the signal to fall back rather than fail.
 */
export async function appAvailable(): Promise<boolean> {
	try {
		await runHerdrApp(['status']);
		return true;
	} catch {
		return false;
	}
}

/** A string argument from a `do` answer, or undefined. */
export function answerField(
	answer: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = answer[field];
	return typeof value === 'string' ? value : undefined;
}
