import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * The agent profile fields an agent pappardelle knows gets without setting
 * them. A profile's own value always wins.
 */
export type BuiltinAgentDefaults = {
	model_args?: string;
	effort_args?: string;
	prompt_args?: string;
	resume_args?: string;
	skill_prefix?: string;
};

/**
 * Defaults per agent, keyed by the command's basename. Lives in scripts/ so
 * resolve-agent-config.sh, which idow runs, reads the same file; the path
 * resolves from both source/ and dist/.
 */
export const BUILTIN_AGENTS: Readonly<Record<string, BuiltinAgentDefaults>> =
	JSON.parse(
		readFileSync(
			path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				'..',
				'scripts',
				'builtin-agents.json',
			),
			'utf8',
		),
	) as Record<string, BuiltinAgentDefaults>;
