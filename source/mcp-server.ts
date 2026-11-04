// `pappardelle mcp`: agents start this for every session on the machine, so it
// stays small and serves nothing outside a Pappardelle repo.
// Tools run the CLI as a subprocess instead of calling its handlers: those exit
// the process and write to stdout, which here is the MCP protocol channel.

import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {configExists, getRepoName} from './config.ts';
import {MCP_TOOLS, type CliCall, type McpTool} from './mcp-tools.ts';
import {spaceFromWorktreePath} from './space-target.ts';

export type CliResult = {code: number | null; stdout: string; stderr: string};
export type RunCli = (call: CliCall, signal: AbortSignal) => Promise<CliResult>;

const COMPANION_RULES = `The companion is the user's view of what you are doing. Keep it showing that, all session:
1. Whenever you are about to ask the user a question or for a decision, in chat or with a question tool, first call companion_run to show what the decision depends on: the diff, the file, the log, the doc. Do this even for small questions
2. Run the app, a dev server or a test watcher in a companion split (companion_run with a pane name and split) instead of a background task, so the user can watch it start. Read its output with companion_read
3. Before you ask the user to review something, call companion_run to set the companion up for that review: \`hunk diff\`, the running app, the rendered page
4. As the work moves on, change what the companion shows to match, and close splits that no longer help
5. Use named splits for short-lived views. Change main only when it is the right place; the user may be in the middle of something there
6. When the user says what they want in the companion, do that instead`;

export function workspaceInstructions(
	space: string | undefined,
	repoName: string | undefined,
): string {
	if (!space) {
		return "This repo uses Pappardelle, which gives each issue a git worktree, an agent session and a companion pane. This session isn't in a space, so pass `space` to the companion tools. Use this server's tools rather than tmux. The pappardelle-agent skill covers updating and restarting Pappardelle.";
	}

	return `You are in Pappardelle space ${space}${repoName ? ` (repo ${repoName})` : ''}. Pappardelle gives each issue a git worktree, an agent session and a companion pane next to it, and the user watches both. Use this server's tools rather than tmux; they target your own space unless you pass \`space\`. The pappardelle-agent skill covers updating and restarting Pappardelle.

${COMPANION_RULES}`;
}

/**
 * Codex and Pi don't show the model a server's instructions, but every client
 * shows it tool descriptions, so the rules go here too.
 */
function toolDescription(tool: McpTool, space: string | undefined): string {
	return tool.name === 'companion_run' && space
		? `${tool.description}\n\nYou are in Pappardelle space ${space}. ${COMPANION_RULES}`
		: tool.description;
}

export function createMcpServer(options: {
	inRepo: boolean;
	space?: string;
	repoName?: string;
	runCli: RunCli;
}): McpServer {
	const {inRepo, space, repoName, runCli} = options;
	const server = new McpServer(
		{name: 'pappardelle', version: '1.0.0'},
		inRepo ? {instructions: workspaceInstructions(space, repoName)} : {},
	);
	if (!inRepo) return server;

	for (const tool of MCP_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: toolDescription(tool, space),
				inputSchema: tool.inputSchema,
				annotations: {
					readOnlyHint: tool.readOnly,
					destructiveHint: tool.destructive,
				},
			},
			async (input: Record<string, unknown>, extra) => {
				const {code, stdout, stderr} = await runCli(
					tool.toCli(input),
					extra.signal,
				);
				// Separate blocks, so a warning on stderr can't corrupt JSON on stdout.
				const output = [stdout, stderr]
					.map(text => text.trim())
					.filter(Boolean);
				const blocks = (texts: string[]) =>
					texts.map(text => ({type: 'text' as const, text}));
				if (code === 0) {
					return {
						content: blocks(output.length > 0 ? output : ['Done']),
					};
				}

				return {
					isError: true,
					content: blocks([...output, `exit ${code}`]),
				};
			},
		);
	}

	return server;
}

/**
 * Runs the same build as this server, with the space this server worked out.
 * execArgv carries tsx's loader when running from source.
 */
const spawnCli =
	(space: string | undefined): RunCli =>
	async ({args, stdin, cwd}, signal) =>
		new Promise(resolve => {
			const entry = import.meta.filename.endsWith('.ts') ? 'cli.tsx' : 'cli.js';
			const child = spawn(
				process.execPath,
				[...process.execArgv, path.join(import.meta.dirname, entry), ...args],
				{
					signal,
					stdio: 'pipe',
					cwd,
					env: space ? {...process.env, PAPPARDELLE_SPACE: space} : process.env,
				},
			);
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
				stderr += chunk;
			});
			child.on('error', error => {
				stderr += error.message;
			});
			child.on('close', code => {
				resolve({code, stdout, stderr});
			});
			// A command that fails before reading its text closes the pipe early.
			child.stdin.on('error', () => {});
			child.stdin.end(stdin);
		});

/** Resolves when the client closes the connection. */
export async function runMcpServer(): Promise<void> {
	let repoName: string | undefined;
	try {
		repoName = getRepoName();
	} catch {
		// A key in the environment is enough to name the space.
	}

	const space =
		process.env['PAPPARDELLE_SPACE'] ||
		(repoName && spaceFromWorktreePath(process.cwd(), homedir(), repoName)) ||
		undefined;
	const inRepo = Boolean(space) || configExists();
	const closed = new Promise(resolve => {
		process.stdin.once('close', resolve);
	});
	await createMcpServer({
		inRepo,
		space,
		repoName,
		runCli: spawnCli(space),
	}).connect(new StdioServerTransport());
	await closed;
}
