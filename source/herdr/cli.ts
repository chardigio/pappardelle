// The herdr session server arranges hc terminals into workspaces, tabs and
// panes. It speaks line-delimited JSON-RPC, but closes a connection after a
// single request, so a long-lived client cannot hold it open: every call goes
// through the `herdr` CLI, which owns the handshake and prints one JSON
// document per invocation.
//
// herdr-core is different. Its socket serves many requests per connection, so
// terminals talk to it directly (see client.ts) and skip the process spawn.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/** A failure the CLI reported in its JSON body, keeping the stable `code`. */
export class HerdrCliError extends Error {
	readonly code: string;
	readonly args: readonly string[];

	constructor(args: readonly string[], code: string, message: string) {
		super(`herdr ${args.join(' ')} failed (${code}): ${message}`);
		this.name = 'HerdrCliError';
		this.code = code;
		this.args = args;
	}
}

type CliAnswer = {
	id?: string;
	result?: unknown;
	error?: {code?: string; message?: string};
};

const CLI_TIMEOUT_MS = 15_000;

/**
 * Run one `herdr` command and return its `result`.
 *
 * Every command prints a single JSON document. A command that fails prints it
 * with an `error` body and exits 1, so the body is read before the exit status
 * is judged: the body says why, the status only says that it did.
 */
/** No JSON at all but the command succeeded: it acknowledges by exiting. */
const SILENT_SUCCESS = Symbol('silent-success');

export async function herdrCli<T = Record<string, unknown>>(
	args: readonly string[],
): Promise<T> {
	let stdout = '';
	let stderr = '';
	let failure: Error | undefined;

	try {
		const result = await execFileAsync('herdr', [...args], {
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
		failure = error instanceof Error ? error : new Error(String(error));
	}

	const body = parseAnswer(stdout);
	if (body?.error) {
		const detail = body.error.message ?? (stderr.trim() || 'unknown error');
		throw new HerdrCliError(args, body.error.code ?? 'error', detail);
	}

	if (body !== null) return (body.result ?? {}) as T;

	// No JSON body. Commands that only acknowledge (`pane run`, `pane rename`)
	// print nothing and exit 0; a failure still exits non-zero.
	if (!failure) return SILENT_SUCCESS as unknown as T;

	throw new HerdrCliError(
		args,
		stderr.includes('no herdr server is running')
			? 'server_not_running'
			: 'unavailable',
		stderr.trim() || failure.message,
	);
}

/** The single JSON document a CLI call prints, or null when it printed none. */
function parseAnswer(stdout: string): CliAnswer | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;

	// One document per call, but a warning line could precede it; take the
	// first line that parses as an object with the expected shape.
	for (const line of trimmed.split('\n')) {
		const candidate = line.trim();
		if (!candidate.startsWith('{')) continue;
		try {
			return JSON.parse(candidate) as CliAnswer;
		} catch {
			continue;
		}
	}

	return null;
}

/** `true` when the failure only says the thing asked about is absent. */
export function isMissing(error: unknown): boolean {
	return (
		error instanceof HerdrCliError &&
		(error.code === 'not_found' || error.code === 'server_not_running')
	);
}
