// `pappardelle mcp`: agents start this for every session on the machine, so it
// stays small and serves nothing unless the repo sets workspace_aware_agents.
// Tools run the CLI as a subprocess instead of calling its handlers: those exit
// the process and write to stdout, which here is the MCP protocol channel.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	getMainRepoRoot,
	getRepoName,
	getSpaceAgentProfile,
	readConfig,
	SOUS_CHEF_FILE,
	SOUS_CHEF_NAME,
	sousChefLaunch,
	workspaceAwareAgents,
	type ConfigLoad,
	type PappardelleConfig,
} from './config.ts';
import {inlineConfigErrors} from './config-errors.ts';
import {isAgyCommand} from './config-launch-flags.ts';
import {createLogger} from './logger.ts';

const log = createLogger('mcp');
import {companionRules} from './companion-rules.ts';
import {MCP_TOOLS, type CliCall} from './mcp-tools.ts';
import {bunIsolationArgs, isStandalone} from './runtime.ts';
import {callerSpace, readCheckout, type CallerSpace} from './space-target.ts';
import type {SpaceStateDao} from './space-state.ts';
import {createStateDaos} from './state-daos.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

export type CliResult = {code: number | null; stdout: string; stderr: string};
export type RunCli = (call: CliCall, signal: AbortSignal) => Promise<CliResult>;

const MESSAGING =
	"To message the agent in another space, use SendMessage with the space key as `to` (ListAgents lists them): the agent sees who sent it and can reply. `space_send` types into that agent's TUI as if the user did. Codex, Pi and agy agents can't receive SendMessage, so `space_send` is the only way to reach them.";

const AGY_MESSAGING =
	'To message the agent in another space or the sous-chef in `main`, list spaces with `spaces_list` and send a prompt with `space_send` — never use SendMessage.';

const MESSAGE_SOUS_CHEF = `The main checkout's agent coordinates the spaces; reach it with SendMessage to \`${SOUS_CHEF_NAME}\`.`;

const SOUS_CHEF =
	"Sous-chef mode is on: this session coordinates the repo's spaces. Keep the other agents moving: `spaces_list` for the board, `space_watch` with `until: [blocked, idle]` in a loop to catch every space waiting on a person or stopped, `space_state` and `space_question_tabs` to read what it asks, and `space_answer` to answer. Approve every permission prompt with `space_answer` without asking: it holds what leaves the space for the user, so call out each hold, list them with `space_holds` when the user asks, and approve one with `space_hold_resolve` only on their word. Bring each question to the user, and answer it on their word. Nudge an idle agent that stopped with work it can carry on alone, such as waiting on CI or a background task after a restart. When a turn ends without AskUserQuestion, keep a `pappardelle watch` running in the background so changes wake you. Never do task-level work yourself: investigate and plan with the user, then file a new issue and open a space for the task with `space_open`. Small upkeep, such as a configuration change or fixing CI, can be done here. Name every issue by its number and a short title, the same words each time, never the number alone. The /sous-chef skill has the full kitchen routine.";

export function workspaceInstructions(
	space: string | undefined,
	repoName: string | undefined,
	options: {
		sousChef?: boolean;
		/** The SOUS-CHEF.md to point the coordinator at, when there is one. */
		sousChefFile?: string;
		/** An agy session reads `.agents/rules/pappardelle.md`, so keep MCP instructions aligned. */
		agy?: boolean;
	} = {},
): string {
	const messaging = options.agy ? AGY_MESSAGING : MESSAGING;
	if (!space) {
		return [
			"This repo uses Pappardelle, which gives each issue a git worktree, an agent session and a companion pane. This session isn't in a space, so pass `space` to the companion tools. Use this server's tools rather than tmux. The pappardelle-agent skill covers updating and restarting Pappardelle.",
			...(options.sousChef ? [SOUS_CHEF] : []),
			...(options.sousChef && options.sousChefFile
				? [
						`The user's own instructions for the sous-chef are in ${options.sousChefFile}. Read it before anything else, and follow it where it differs from this routine.`,
					]
				: []),
			messaging,
		].join('\n\n');
	}

	return `You are in Pappardelle space ${space}${repoName ? ` (repo ${repoName})` : ''}. Pappardelle gives each issue a git worktree, an agent session and a companion pane next to it, and the user watches both. Use this server's tools rather than tmux; they target your own space unless you pass \`space\`. The pappardelle-agent skill covers updating and restarting Pappardelle.

${options.sousChef && !options.agy ? `${messaging} ${MESSAGE_SOUS_CHEF}` : messaging}

${companionRules()}`;
}

export type WorkspaceAwareness =
	| {kind: 'on'}
	| {kind: 'off'}
	| {kind: 'invalid-config'; errors: string[]};

function invalidConfigInstructions(errors: string[]): string {
	return `Pappardelle's workspace tools are off because .pappardelle.yml is invalid: ${inlineConfigErrors(errors)}. Tell the user; once it's fixed, restart this session.`;
}

export function createMcpServer(options: {
	awareness: WorkspaceAwareness;
	space?: string;
	sender?: string;
	repoName?: string;
	sousChef?: boolean;
	sousChefFile?: string;
	agy?: boolean;
	runCli: RunCli;
}): McpServer {
	const {awareness, space, repoName, sousChef, sousChefFile, agy, runCli} =
		options;
	const sender = options.sender ?? space;
	let instructions: string | undefined;
	switch (awareness.kind) {
		case 'on': {
			instructions = workspaceInstructions(space, repoName, {
				sousChef,
				sousChefFile,
				agy,
			});
			break;
		}

		case 'off': {
			break;
		}

		case 'invalid-config': {
			instructions = invalidConfigInstructions(awareness.errors);
			break;
		}
	}

	const server = new McpServer(
		{name: 'pappardelle', version: '1.0.0'},
		instructions === undefined ? {} : {instructions},
	);
	if (awareness.kind !== 'on') return server;

	for (const tool of MCP_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: {
					readOnlyHint: tool.readOnly,
					destructiveHint: tool.destructive,
				},
			},
			async (input: Record<string, unknown>, extra) => {
				const call = tool.toCli(input, {sender});
				const {code, stdout, stderr} = await runCli(call, extra.signal);
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
 * The compiled executable runs its CLI itself; a source run names its entry
 * file, which sits beside this module.
 */
const spawnCli =
	(space: string | undefined): RunCli =>
	async ({args, stdin, cwd}, signal) =>
		new Promise(resolve => {
			const child = spawn(
				process.execPath,
				isStandalone
					? args
					: [
							...bunIsolationArgs,
							path.join(import.meta.dirname, 'cli.tsx'),
							...args,
						],
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

function findSousChefFile(): string | undefined {
	try {
		const file = path.join(getMainRepoRoot(), SOUS_CHEF_FILE);
		return fs.existsSync(file) ? file : undefined;
	} catch {
		return undefined;
	}
}

function workspaceAwareness(load: ConfigLoad): WorkspaceAwareness {
	switch (load.kind) {
		case 'valid': {
			return workspaceAwareAgents(load.config) ? {kind: 'on'} : {kind: 'off'};
		}

		case 'missing': {
			return {kind: 'off'};
		}

		case 'invalid': {
			return {kind: 'invalid-config', errors: load.errors};
		}
	}
}

export function callerIsAgy(options: {
	caller: CallerSpace;
	config: PappardelleConfig | null;
	spaceState: Pick<SpaceStateDao, 'read'> | null;
}): boolean {
	const {caller, config, spaceState} = options;
	if (caller.kind === 'none' || !config) return false;
	const profile = getSpaceAgentProfile(config, spaceState?.read(caller.key));
	return isAgyCommand(profile.command);
}

/** Resolves when the client closes the connection. */
export async function runMcpServer(): Promise<void> {
	const checkout = readCheckout({
		repoName: getRepoName,
		mainRoot: getMainRepoRoot,
	});
	const daos =
		checkout.kind === 'checkout'
			? createStateDaos({repo: checkout.checkout.repoName})
			: null;
	const caller = callerSpace({
		env: process.env,
		cwd: process.cwd(),
		checkout,
		identities: repo =>
			checkout.kind === 'checkout' &&
			repo === checkout.checkout.repoName &&
			daos
				? daos.spaceIdentities
				: createStateDaos({repo}).spaceIdentities,
	});
	// The main checkout's session gets the instructions for a session in no
	// space, which are where the sous-chef's routine is given.
	const space =
		caller.kind === 'none' || caller.key === MAIN_WORKTREE_KEY
			? undefined
			: caller.key;
	const repoName =
		checkout.kind === 'checkout' ? checkout.checkout.repoName : undefined;
	const load = readConfig();
	const config = load.kind === 'valid' ? load.config : null;
	const awareness = workspaceAwareness(load);
	if (awareness.kind === 'invalid-config')
		log.error(invalidConfigInstructions(awareness.errors));
	const sousChef =
		awareness.kind === 'on' && sousChefLaunch(config) !== undefined;
	const sender = caller.kind === 'none' ? undefined : caller.key;
	const agy = callerIsAgy({
		caller,
		config,
		spaceState: daos?.spaceState ?? null,
	});
	const closed = new Promise(resolve => {
		process.stdin.once('close', resolve);
	});
	await createMcpServer({
		awareness,
		space,
		sender,
		repoName,
		sousChef,
		sousChefFile: sousChef && !space ? findSousChefFile() : undefined,
		agy,
		runCli: spawnCli(space),
	}).connect(new StdioServerTransport());
	await closed;
}
