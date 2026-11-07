import type {AgentProfileConfig} from './config.ts';
import builtinAgents from '../scripts/builtin-agents.json';

/**
 * The agent profile fields an agent pappardelle knows gets without setting
 * them. A profile's own value always wins.
 */
export type BuiltinAgentDefaults = Pick<
	AgentProfileConfig,
	'model_args' | 'effort_args' | 'prompt_args' | 'resume_args' | 'skill_prefix'
>;

/**
 * Defaults per agent, keyed by the command's basename. Lives in scripts/ so
 * resolve-agent-config.sh, which idow runs, reads the same file.
 */
export const BUILTIN_AGENTS: Readonly<Record<string, BuiltinAgentDefaults>> =
	builtinAgents;
