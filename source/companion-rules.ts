// The rules that keep the companion showing an agent's work, in one file for
// every route to the model: the MCP server's instructions, the launch flags
// below, and agy's rule file. resolve-agent-config.sh renders the same flags
// for sessions idow starts.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {isAgyCommand, quoteLaunchValue} from './config-launch-flags.ts';
import {scriptsDir} from './runtime.ts';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = scriptsDir;
const RULES_PLACEHOLDER = '{rules}';

export {isAgyCommand, unwrappedCommandWord} from './config-launch-flags.ts';

export function companionRules(): string {
	return fs
		.readFileSync(path.join(SCRIPTS_DIR, 'companion-rules.txt'), 'utf8')
		.trim();
}

/**
 * The rules flags from an agent's `rules_args`, with a leading space, or ''
 * for an agent that doesn't take the rules at launch. The rules go on one line
 * so a launch command stays one line in any shell.
 */
export function agentRulesFlags(rulesArgs: readonly string[]): string {
	if (rulesArgs.length === 0) return '';
	const rules = companionRules().replaceAll(/\s*\n\s*/g, ' ');
	return rulesArgs
		.map(
			word =>
				` ${quoteLaunchValue(word.replaceAll(RULES_PLACEHOLDER, () => rules))}`,
		)
		.join('');
}

export async function installAgentRules(
	command: string,
	worktreePath: string,
	options: {
		space?: string;
		repo?: string;
		role?: 'sous-chef' | 'worker';
	} = {},
): Promise<void> {
	if (!isAgyCommand(command)) return;
	await execFileAsync(path.join(SCRIPTS_DIR, 'install-agent-rules.sh'), [
		command,
		worktreePath,
		...(options.space ? ['--space', options.space] : []),
		...(options.repo ? ['--repo', options.repo] : []),
		...(options.role ? ['--role', options.role] : []),
	]);
}
