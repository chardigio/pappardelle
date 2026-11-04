// The rules that keep the companion showing an agent's work, in one file for
// every route to the model: the MCP server's instructions, the launch flags
// below, and agy's rule file. resolve-agent-config.sh renders the same flags
// for sessions idow starts.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {commandBasename} from './config.ts';
import {shellQuote} from './shell-quote.ts';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(import.meta.dirname, '..', 'scripts');

export function companionRules(): string {
	return fs
		.readFileSync(path.join(SCRIPTS_DIR, 'companion-rules.txt'), 'utf8')
		.trim();
}

/**
 * Flags for the agents that don't show the model a server's instructions but
 * can add to their prompt at launch, with a leading space, or '' for the rest.
 * The rules go on one line so a launch command stays one line in any shell.
 */
export function agentRulesFlags(command: string): string {
	const agent = commandBasename(command);
	if (agent !== 'codex' && agent !== 'pi') return '';
	const rules = companionRules().replaceAll(/\s*\n\s*/g, ' ');
	return agent === 'codex'
		? ` -c ${shellQuote(`developer_instructions="${rules}"`)}`
		: ` --append-system-prompt ${shellQuote(rules)}`;
}

export async function installAgentRules(
	command: string,
	worktreePath: string,
): Promise<void> {
	if (commandBasename(command) !== 'agy') return;
	await execFileAsync(path.join(SCRIPTS_DIR, 'install-agent-rules.sh'), [
		command,
		worktreePath,
	]);
}
