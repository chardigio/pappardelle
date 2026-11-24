// The second gate on approving another space's prompt: a command that clears
// the hard stops in approve-policy.ts, and any tool call the rules don't
// place, is judged by a small model, so the policy stays open-ended without a
// hand-kept list of safe programs. It approves by default and says no only to
// what leaves the space. A check that fails to run says so, rather than no,
// so the prompt waits for another try instead of being declined.

import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import type {ApprovalVerdict} from './approve-policy.ts';

export type ClassifierVerdict =
	| ApprovalVerdict
	| {kind: 'unavailable'; reason: string};

export type ClassifyRequest = {
	/** The prompt's header, such as `Bash command` or `Tool use`. */
	tool: string;
	/** What the agent says the call is for. */
	description: string;
	/** The command, or the tool call's arguments as the prompt shows them. */
	command: string;
	/** The space's worktree; null for the main checkout. */
	worktree: string | null;
	/** Where the agent runs the command. */
	cwd: string | null;
	tempRoots: readonly string[];
};

export type ClassifierRun = (
	args: string[],
	input: string,
	timeoutMs: number,
) => Promise<{status: number | null; stdout: string}>;

const TIMEOUT_MS = 30_000;

const RUBRIC = `You decide whether a tool call that an AI coding agent wants to make may be approved without asking a person. The agent works in its own space: its worktree, the temp directories listed, and local git. Approve unless the call does one of these:
- Sends secrets, credentials or private files off the machine
- Deletes or overwrites anything outside the worktree or the temp directories
- Writes to another worktree, the main checkout, or an agent's permission settings
- Changes system configuration, services, users or permissions
- Deploys, or reads or writes production data or a remote database, migrations included
- Pushes to main, master or the default branch
- Removes git state every space shares: stash entries, other worktrees, or branches that aren't this space's own
- Changes its own or another agent's permissions, approvals or prompts

Pushes to other branches, creating, commenting on and merging pull requests, builds, tests, installs, reads, searches, git on the space's own branch and edits inside the worktree are all fine. Give a one-sentence reason.`;

const SCHEMA = JSON.stringify({
	type: 'object',
	properties: {approve: {type: 'boolean'}, reason: {type: 'string'}},
	required: ['approve', 'reason'],
});

export function classifierArgs(): string[] {
	return [
		'-p',
		'--model',
		'haiku',
		'--tools',
		'',
		'--strict-mcp-config',
		// No user or project settings, so no hooks or plugins of this machine
		// run inside the check.
		'--setting-sources',
		'',
		'--no-session-persistence',
		'--output-format',
		'json',
		'--json-schema',
		SCHEMA,
		'--system-prompt',
		RUBRIC,
	];
}

export function classifierInput(request: ClassifyRequest): string {
	return [
		`Tool: ${request.tool || 'unknown'}`,
		...(request.description ? [`Purpose: ${request.description}`] : []),
		`Worktree: ${request.worktree ?? 'none (the main checkout)'}`,
		`Working directory: ${request.cwd ?? 'unknown'}`,
		`Temp directories: ${request.tempRoots.join(', ')}`,
		'Call:',
		request.command,
	].join('\n');
}

export function parseClassifierOutput(stdout: string): ClassifierVerdict {
	let verdict: unknown;
	try {
		verdict = (JSON.parse(stdout) as {structured_output?: unknown})
			.structured_output;
	} catch {
		return {kind: 'unavailable', reason: 'the approval check gave no answer'};
	}

	const {approve, reason} = (verdict ?? {}) as {
		approve?: unknown;
		reason?: unknown;
	};
	const why = typeof reason === 'string' ? reason : '';
	if (approve === true) return {kind: 'approve', reason: why};
	if (approve === false && why)
		return {kind: 'hold', reason: `the approval check said no: ${why}`};
	return {kind: 'unavailable', reason: 'the approval check gave no answer'};
}

async function classifyOnce(
	request: ClassifyRequest,
	run: ClassifierRun,
): Promise<ClassifierVerdict> {
	let result;
	try {
		result = await run(classifierArgs(), classifierInput(request), TIMEOUT_MS);
	} catch (error) {
		return {
			kind: 'unavailable',
			reason: `the approval check didn't run: ${(error as Error).message}`,
		};
	}

	if (result.status !== 0) {
		return {kind: 'unavailable', reason: 'the approval check failed'};
	}

	return parseClassifierOutput(result.stdout);
}

/** One retry, since a check that failed to run says nothing about the call. */
export async function classifyCommand(
	request: ClassifyRequest,
	run: ClassifierRun,
): Promise<ClassifierVerdict> {
	const first = await classifyOnce(request, run);
	return first.kind === 'unavailable' ? classifyOnce(request, run) : first;
}

/** Runs `claude` away from any space, so its hooks can't report as one. */
export const defaultClassifierRun: ClassifierRun = async (
	args,
	input,
	timeoutMs,
) =>
	new Promise((resolve, reject) => {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) =>
					!name.startsWith('PAPPARDELLE_') &&
					name !== 'TMUX' &&
					name !== 'TMUX_PANE',
			),
		);
		const child = spawn('claude', args, {
			cwd: tmpdir(),
			env,
			stdio: ['pipe', 'pipe', 'ignore'],
		});
		// Settles on the deadline itself: a child of claude that keeps stdout
		// open would otherwise hold the answer past it.
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);
		let stdout = '';
		child.stdout.on('data', (chunk: Uint8Array) => {
			stdout += String(chunk);
		});
		child.on('error', error => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', status => {
			clearTimeout(timer);
			resolve({status, stdout});
		});
		child.stdin.end(input);
	});
