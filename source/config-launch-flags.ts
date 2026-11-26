import path from 'node:path';
import {BUILTIN_AGENTS, type BuiltinAgentDefaults} from './builtin-agents.ts';
import type {AgentProfileConfig, ResolvedAgentProfile} from './config.ts';
import {shellQuote} from './shell-quote.ts';

/**
 * Launch fields that exist identically on agent profiles and, deprecated, on
 * the top-level and per-profile `claude:` blocks.
 */
export const LAUNCH_FIELDS = ['model', 'effort'] as const;

export type LaunchField = (typeof LAUNCH_FIELDS)[number];

/**
 * Launch fields supported on agent profiles, including agent-profile-only
 * fields such as `mode` that must stay out of `LAUNCH_FIELDS` (which feeds
 * deprecated `claude:` warnings and config rewrites).
 */
export const AGENT_PROFILE_LAUNCH_FIELDS = [...LAUNCH_FIELDS, 'mode'] as const;

export type AgentProfileLaunchField =
	(typeof AGENT_PROFILE_LAUNCH_FIELDS)[number];

export const PROMPT_PLACEHOLDER = '{prompt}';

/**
 * The built-in defaults an agent profile gets (scripts/builtin-agents.json).
 * The claude entry follows the claude gate rather than the basename, so a
 * wrapper with `is_claude: true` gets it and a `claude` with
 * `is_claude: false` doesn't. String inspection only, so
 * resolve-agent-config.sh applies the same rule.
 */
export function builtinAgentDefaults(
	definition: Pick<AgentProfileConfig, 'command' | 'is_claude'>,
): BuiltinAgentDefaults {
	if (isClaudeAgentProfile(definition)) return BUILTIN_AGENTS['claude']!;
	const word = unwrapCommand(definition.command)?.word;
	const name = word ? path.basename(word) : '';
	return name !== 'claude' && Object.hasOwn(BUILTIN_AGENTS, name)
		? BUILTIN_AGENTS[name]!
		: {};
}

/**
 * Before prompt_args, agy profiles ended model_args with `-i` so the bare
 * prompt after it went to that flag. With the built-in `-i {prompt}` that
 * flag now comes twice, and on resume it takes `--conversation` as the
 * prompt. The flag, for a profile that gets a built-in `<flag> {prompt}`.
 */
export function builtinPromptFlag(
	definition: Pick<AgentProfileConfig, 'command' | 'is_claude' | 'prompt_args'>,
): string | undefined {
	if (definition.prompt_args !== undefined) return undefined;
	const [before, after] = (
		builtinAgentDefaults(definition).prompt_args ?? ''
	).split(PROMPT_PLACEHOLDER);
	const flag = before?.trim();
	return after === '' && flag ? flag : undefined;
}

/**
 * Model ids like `claude-opus-5[1m]` carry glob characters, so anything that
 * isn't a bare token is single-quoted. resolve-agent-config.sh quotes the same
 * way, which keeps TUI- and idow-created launch lines identical.
 */
export function quoteLaunchValue(value: string): string {
	return /^[A-Za-z0-9._-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * Render the model/effort/mode flags, then the extra args, for an agent
 * profile, each with a leading space, or '' when none apply. An unset value or
 * a CLI without a template passes no flag.
 */
export function renderAgentLaunchFlags(
	agentProfile: Partial<
		Pick<
			ResolvedAgentProfile,
			| 'model'
			| 'effort'
			| 'mode'
			| 'modelArgs'
			| 'effortArgs'
			| 'modeArgs'
			| 'extraArgs'
		>
	>,
): string {
	let flags = '';
	for (const field of AGENT_PROFILE_LAUNCH_FIELDS) {
		const value = agentProfile[field];
		const template = agentProfile[`${field}Args`];
		if (!value || !template) continue;
		const quoted = quoteLaunchValue(value);
		// A function, so `$'` and `$&` in the value aren't replacement patterns.
		flags += ` ${template.replaceAll(`{${field}}`, () => quoted)}`;
	}
	for (const arg of agentProfile.extraArgs ?? []) {
		flags += ` ${quoteLaunchValue(arg)}`;
	}
	return flags;
}

/**
 * Render a launch prompt through `promptArgs` (substituting `{prompt}` with a
 * shell-quoted value) or as a bare shell-quoted argument, with a leading space.
 */
export function renderAgentPrompt(prompt: string, promptArgs?: string): string {
	const quoted = quoteLaunchValue(prompt);
	const rendered = promptArgs?.includes(PROMPT_PLACEHOLDER)
		? promptArgs.replace(PROMPT_PLACEHOLDER, () => quoted)
		: quoted;
	return ` ${rendered}`;
}

/**
 * Stands in for the space's recorded agent session id in `resume_args`. A
 * resume by id is what keeps a space on its own conversation: "most recent"
 * flags like codex's `resume --last` aren't scoped to the directory, so they
 * resume whichever space ran that agent last.
 */
export const SESSION_ID_PLACEHOLDER = '{session_id}';

/**
 * Claude's `--continue` is scoped to the directory, so it is a safe stand-in
 * when no id was recorded: spaces whose sessions predate id recording, or
 * whose hook never ran, keep their conversation.
 */
const CLAUDE_UNRECORDED_RESUME_ARGS = '--continue';

/** Claude's resume-by-id flag, in each spelling claude accepts. */
const CLAUDE_RESUME_BY_ID = /(?:--resume[ =]|-r )\{session_id\}/g;

/**
 * Fill `{session_id}` in an agent profile's resume args. Without a usable id,
 * claude's resume-by-id flag becomes `--continue`, keeping any other flags
 * (`--fork-session`), and any other agent drops the resume attempt
 * (`undefined`) rather than run with a literal placeholder. The id lands
 * unquoted in a shell command, hence the charset check; claude and codex ids
 * are UUIDs, and a leading dash would turn the id into a flag.
 */
export function bindResumeArgs(
	agentProfile: Pick<ResolvedAgentProfile, 'resumeArgs' | 'isClaude'>,
	sessionId: string | undefined,
): string | undefined {
	const {resumeArgs} = agentProfile;
	if (!resumeArgs?.includes(SESSION_ID_PLACEHOLDER)) return resumeArgs;
	if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
		if (!agentProfile.isClaude) return undefined;
		const continued = resumeArgs.replaceAll(
			CLAUDE_RESUME_BY_ID,
			CLAUDE_UNRECORDED_RESUME_ARGS,
		);
		return continued.includes(SESSION_ID_PLACEHOLDER)
			? CLAUDE_UNRECORDED_RESUME_ARGS
			: continued;
	}

	return resumeArgs.replaceAll(SESSION_ID_PLACEHOLDER, sessionId);
}

/**
 * Whether a command string gets claude treatment (pre-trust, --name/model/
 * effort/dsp injection): basename of the first whitespace-separated token
 * equals 'claude'. String inspection only — no probing the binary — so the
 * bash resolver (resolve-agent-config.sh) can apply the identical rule. An agent
 * profile's explicit `is_claude` overrides this.
 */
export function isClaudeCommand(command: string): boolean {
	return commandBasename(command) === 'claude';
}

export function isClaudeAgentProfile(
	definition: Pick<AgentProfileConfig, 'command' | 'is_claude'>,
): boolean {
	return definition.is_claude ?? isClaudeCommand(definition.command);
}

/**
 * Whether a resolved agent profile accepts the `<skill_prefix>sous-chef`
 * launch prompt. Unregistered CLIs without `prompt_args` (such as Pi,
 * opencode, or wrapped binaries — even if they set `skill_prefix` for
 * `send_skill`) would otherwise receive a bare `'/sous-chef'` argument.
 */
export function supportsSousChefPrompt(
	agentProfile: Pick<
		ResolvedAgentProfile,
		'command' | 'isClaude' | 'promptArgs'
	>,
): boolean {
	const word = unwrapCommand(agentProfile.command)?.word;
	return (
		agentProfile.isClaude ||
		Boolean(agentProfile.promptArgs) ||
		(word !== undefined && path.basename(word) === 'codex')
	);
}

export function commandBasename(command: string): string {
	const firstToken = command.trim().split(/\s+/)[0] ?? '';
	return path.basename(firstToken);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_ARG_FLAGS = new Set([
	'-u',
	'--unset',
	'-C',
	'--chdir',
	'-S',
	'--split-string',
]);

export type UnwrappedCommand = {
	word: string;
	env: Record<string, string>;
	unset: string[];
};

function stripOuterQuotes(value: string): string {
	return value.length >= 2 &&
		((value.startsWith("'") && value.endsWith("'")) ||
			(value.startsWith('"') && value.endsWith('"')))
		? value.slice(1, -1)
		: value;
}

/**
 * Unwraps leading `VAR=val` assignments and `env` wrappers from an agent
 * launch command string, returning the target command word, assigned env vars,
 * and any explicitly unset env var names.
 */
export function unwrapCommand(command: string): UnwrappedCommand | null {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	const env = new Map<string, string>();
	const unset: string[] = [];
	let inEnv = false;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (ENV_ASSIGNMENT.test(token)) {
			const eq = token.indexOf('=');
			env.set(token.slice(0, eq), stripOuterQuotes(token.slice(eq + 1)));
			continue;
		}

		if (inEnv && token.startsWith('-')) {
			if (ENV_ARG_FLAGS.has(token)) {
				const target = tokens[++index];
				if ((token === '-u' || token === '--unset') && target) {
					unset.push(target);
					env.delete(target);
				}
			}

			continue;
		}

		if (path.posix.basename(token) === 'env') {
			inEnv = true;
			continue;
		}

		return {word: token, env: Object.fromEntries(env), unset};
	}

	return null;
}

export function isAgyCommand(command: string): boolean {
	const word = unwrapCommand(command)?.word;
	return word !== undefined && path.posix.basename(word) === 'agy';
}
