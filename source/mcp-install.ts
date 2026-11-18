// `pappardelle mcp install`: registers `pappardelle mcp` with the agents that
// can't load the Claude Code plugin, through each one's own `mcp add` so their
// config files keep their comments and symlinks. Claude Code gets the server
// and its auto-approval from the plugin instead.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {AUTO_APPROVED_TOOLS} from './mcp-tools.ts';

const SERVER = 'pappardelle';

export type RunResult = {status: number | null; error?: Error};

export type McpInstallDeps = {
	run: (command: string, args: string[]) => RunResult;
	home: string;
	/** Codex's config directory, which CODEX_HOME can move. */
	codexHome: string;
	/** How the agents start the server: the shim, by path when it's installed. */
	serverCommand: string;
	readFile: (file: string) => string | undefined;
	writeFile: (file: string, content: string) => void;
	print: (line: string) => void;
};

function approveInCodex(deps: McpInstallDeps): void {
	const file = path.join(deps.codexHome, 'config.toml');
	let config = deps.readFile(file) ?? '';
	for (const tool of AUTO_APPROVED_TOOLS) {
		const table = `[mcp_servers.${SERVER}.tools.${tool}]`;
		if (!config.includes(table))
			config += `\n${table}\napproval_mode = "approve"\n`;
	}

	deps.writeFile(file, config);
}

function approveInAgy(deps: McpInstallDeps): void {
	const file = path.join(
		deps.home,
		'.gemini',
		'antigravity-cli',
		'settings.json',
	);
	const current = deps.readFile(file);
	let settings: {permissions?: {allow?: string[]}};
	try {
		settings = current === undefined ? {} : JSON.parse(current);
	} catch {
		deps.print(
			`Could not parse ${file}; allow mcp(${SERVER}/companion_run) and the other companion tools by hand.`,
		);
		return;
	}

	const allow = settings.permissions?.allow ?? [];
	const rules = AUTO_APPROVED_TOOLS.map(tool => `mcp(${SERVER}/${tool})`);
	settings.permissions = {
		...settings.permissions,
		allow: [...allow, ...rules.filter(rule => !allow.includes(rule))],
	};
	deps.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
}

type Agent = {
	binary: string;
	addArgs: (serverCommand: string) => string[];
	approve?: (deps: McpInstallDeps) => void;
};

// Neither OpenCode nor Pi asks before an MCP tool call by default, so they have
// nothing to approve.
const AGENTS: Agent[] = [
	{
		binary: 'codex',
		addArgs: command => ['mcp', 'add', SERVER, '--', command, 'mcp'],
		approve: approveInCodex,
	},
	{
		binary: 'opencode',
		addArgs: command => [
			'mcp',
			'add',
			'--global',
			SERVER,
			'--',
			command,
			'mcp',
		],
	},
	{
		binary: 'agy',
		addArgs: command => ['mcp', 'add', SERVER, command, 'mcp'],
		approve: approveInAgy,
	},
	{
		binary: 'pi',
		// Pi's default, codemode, hides tools from the model until a script looks
		// them up, and an agent can't be proactive with tools it hasn't seen.
		addArgs: command => [
			'mcp',
			'add',
			SERVER,
			'--exposure',
			'direct',
			'--',
			command,
			'mcp',
		],
	},
];

/** Returns a nonzero status when an installed agent couldn't be registered. */
export function installMcpServer(deps: McpInstallDeps): number {
	let status = 0;
	for (const agent of AGENTS) {
		const result = deps.run(agent.binary, agent.addArgs(deps.serverCommand));
		if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
			continue;
		if (result.status !== 0) {
			deps.print(
				`Could not add the Pappardelle MCP server to ${agent.binary}.`,
			);
			status = 1;
			continue;
		}

		try {
			agent.approve?.(deps);
			deps.print(`Added the Pappardelle MCP server to ${agent.binary}.`);
		} catch (error) {
			deps.print(
				`Added the Pappardelle MCP server to ${agent.binary}, but could not auto-approve its companion tools: ${error instanceof Error ? error.message : String(error)}`,
			);
			status = 1;
		}
	}

	return status;
}

export function defaultMcpInstallDeps(): McpInstallDeps {
	const home = homedir();
	const shim = path.join(home, '.local', 'bin', 'pappardelle');
	return {
		home,
		codexHome: process.env['CODEX_HOME'] ?? path.join(home, '.codex'),
		serverCommand: fs.existsSync(shim) ? shim : 'pappardelle',
		run(command, args) {
			const result = spawnSync(command, args, {stdio: 'ignore'});
			return {status: result.status, error: result.error};
		},
		readFile(file) {
			try {
				return fs.readFileSync(file, 'utf8');
			} catch {
				return undefined;
			}
		},
		writeFile(file, content) {
			fs.mkdirSync(path.dirname(file), {recursive: true});
			fs.writeFileSync(file, content);
		},
		print(line) {
			console.log(line);
		},
	};
}
