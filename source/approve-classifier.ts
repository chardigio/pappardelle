// The second gate on approving another space's command: a command that clears
// the hard refusals in approve-policy.ts is judged by a small model, so the
// policy can stay open-ended without a hand-kept list of safe programs. Any
// failure to get a clear yes leaves the prompt for a person.

import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import type {ApprovalVerdict} from './approve-policy.ts';

export type ClassifyRequest = {
	command: string;
	/** Where the agent runs the command: its worktree. */
	cwd: string | null;
	scratchRoots: readonly string[];
};

export type ClassifierRun = (
	args: string[],
	input: string,
	timeoutMs: number,
) => Promise<{status: number | null; stdout: string}>;

const TIMEOUT_MS = 30_000;

const RUBRIC = `You decide whether a shell command that an AI coding agent wants to run may be approved without asking a person.

Approve only when all of these hold:
- It publishes nothing: no pushes, releases, deploys, package publishes, posts, messages or changes to remote services
- It deletes or overwrites nothing outside the agent's working directory or the temp scratch directories listed
- It sends no secrets, credentials or private files off the machine
- It doesn't download code and run it, or change system configuration, services, users or permissions

Builds, tests, linters, reads, searches, git commands that stay local, and edits inside the working directory are fine. When you can't tell what the command does, don't approve it. Give a one-sentence reason.`;

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
		`Working directory: ${request.cwd ?? 'unknown'}`,
		`Temp scratch directories: ${request.scratchRoots.join(', ')}`,
		'Command:',
		request.command,
	].join('\n');
}

export function parseClassifierOutput(stdout: string): ApprovalVerdict {
	let verdict: unknown;
	try {
		verdict = (JSON.parse(stdout) as {structured_output?: unknown})
			.structured_output;
	} catch {
		return {allow: false, reason: 'the approval check gave no answer'};
	}

	const {approve, reason} = (verdict ?? {}) as {
		approve?: unknown;
		reason?: unknown;
	};
	const why = typeof reason === 'string' ? reason : '';
	if (approve === true) return {allow: true, reason: why};
	return {
		allow: false,
		reason: why
			? `the approval check said no: ${why}`
			: 'the approval check gave no answer',
	};
}

export async function classifyCommand(
	request: ClassifyRequest,
	run: ClassifierRun,
): Promise<ApprovalVerdict> {
	let result;
	try {
		result = await run(classifierArgs(), classifierInput(request), TIMEOUT_MS);
	} catch (error) {
		return {
			allow: false,
			reason: `the approval check didn't run: ${(error as Error).message}`,
		};
	}

	if (result.status !== 0) {
		return {allow: false, reason: 'the approval check failed'};
	}

	return parseClassifierOutput(result.stdout);
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
