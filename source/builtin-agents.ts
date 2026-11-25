import type {AgentProfileConfig} from './config.ts';
import builtinAgents from '../scripts/builtin-agents.json';

/**
 * What pappardelle knows about an agent without the profile saying so. The
 * profile fields are defaults a profile's own value always wins over.
 * `rules_args` isn't a profile field: it is how the agent takes the companion
 * rules at launch, as argv words with `{rules}` standing in for them.
 */
export type BuiltinAgentDefaults = Pick<
	AgentProfileConfig,
	| 'model_args'
	| 'effort_args'
	| 'mode_args'
	| 'prompt_args'
	| 'resume_args'
	| 'skill_prefix'
> & {rules_args?: string[]};

/**
 * Defaults per agent, keyed by the command's basename. Lives in scripts/ so
 * resolve-agent-config.sh, which idow runs, reads the same file. The binary
 * embeds it at build time, so an edit reaches the TUI only after a rebuild.
 */
export const BUILTIN_AGENTS: Readonly<Record<string, BuiltinAgentDefaults>> =
	builtinAgents;
