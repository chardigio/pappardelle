import {
	bindResumeArgs,
	builtinAgentDefaults,
	getMainRepoRoot,
	getNamedAgentProfile,
	getRepoName,
	renderAgentLaunchFlags,
	resolveAgentProfileName,
	quoteLaunchValue,
	workspaceAwareAgents,
	type PappardelleConfig,
	type ResolvedAgentProfile,
} from './config.ts';
import {readableHookStatusKey} from './claude-status.ts';
import {agentRulesFlags} from './companion-rules.ts';
import {shellQuote} from './shell-quote.ts';
import {readAgentSession} from './space-state.ts';

/**
 * A session that runs outside Pappardelle, on its own tmux server. The
 * iMessage bots are the reason this exists: launchd starts each one through a
 * tmux copy that holds Full Disk Access (to read chat.db), so the inner tmux
 * server can't run them, and a second copy of a bot would answer every text
 * twice. Pappardelle only shows such a session; it never starts or kills it.
 */
export interface PartnerAgentAttach {
	/** `-L` socket name, or a socket path (starts with `/`) for `-S`. */
	socket: string;
	session: string;
}

/**
 * A permanent agent that sits in the top section of the rail beside the main
 * agent (the sous-chef). It has no issue and no worktree: it runs in the main
 * repo root, because it coordinates rather than codes.
 */
export interface PartnerAgentConfig {
	/** Shown left of the status icon. Falls back to the top-level `default_emoji`. */
	emoji?: string;
	/** Agent profile to launch. Falls back to the top-level `agent_profile`. */
	agent_profile?: string;
	/** Prompt for the first launch only; a resume does not run it again. */
	initialization_command?: string;
	/** Show this external session in place of launching an agent. */
	attach?: PartnerAgentAttach;
}

export type PartnerAgent = PartnerAgentConfig & {name: string};

/**
 * Lowercase only, so a name can never read as an issue key (`STA-1`), and
 * never `main`, which is the sous-chef's row and session key.
 */
const NAME_PATTERN = /^[a-z][a-z\d_-]*$/;

export function isPartnerAgentName(name: string): boolean {
	return NAME_PATTERN.test(name) && name !== 'main';
}

export function listPartnerAgents(
	config: Pick<PappardelleConfig, 'agents'> | null | undefined,
): PartnerAgent[] {
	return Object.entries(config?.agents ?? {}).map(([name, agent]) => ({
		...agent,
		name,
	}));
}

export function findPartnerAgent(
	config: Pick<PappardelleConfig, 'agents'> | null | undefined,
	name: string,
): PartnerAgent | undefined {
	const agent = config?.agents?.[name];
	return agent ? {...agent, name} : undefined;
}

/**
 * The key a partner's status is read under. A partner's space key is its
 * name, so the hook files its status like any space's: `<repo>-<name>` with
 * `PAPPARDELLE_REPO` set, else the bare name. Pappardelle sets both for a
 * launched partner. An attached process must export `PAPPARDELLE_SPACE=<name>`
 * itself (and `PAPPARDELLE_REPO`, to keep two repos' partners apart), since
 * Pappardelle doesn't start it.
 */
export function partnerAgentStatusKey(
	repoName: string,
	name: string,
	statusDir?: string,
): string {
	return readableHookStatusKey(repoName, name, statusDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

export function validatePartnerAgents(
	value: unknown,
	agentProfileNames: ReadonlySet<string>,
): string[] {
	if (value === undefined) return [];
	if (!isRecord(value)) return ['agents: must be an object'];
	const errors: string[] = [];
	for (const [name, raw] of Object.entries(value)) {
		const prefix = `agents.${name}`;
		if (!isPartnerAgentName(name))
			errors.push(
				`${prefix}: name must be lowercase letters, digits, - or _, start with a letter, and not be "main"`,
			);
		if (!isRecord(raw)) {
			errors.push(`${prefix}: must be an object`);
			continue;
		}

		for (const field of [
			'emoji',
			'agent_profile',
			'initialization_command',
		] as const) {
			if (raw[field] !== undefined && typeof raw[field] !== 'string')
				errors.push(`${prefix}.${field}: must be a string`);
		}

		const profile = raw['agent_profile'];
		if (
			typeof profile === 'string' &&
			profile !== '' &&
			!agentProfileNames.has(profile)
		)
			errors.push(
				`${prefix}.agent_profile: agent profile "${profile}" not found in agent_profiles`,
			);

		const init = raw['initialization_command'];
		if (typeof init === 'string' && /[\r\n]/.test(init.trimEnd()))
			errors.push(`${prefix}.initialization_command: must be a single line`);

		const {attach} = raw;
		if (attach === undefined) continue;
		if (!isRecord(attach)) {
			errors.push(`${prefix}.attach: must be an object`);
			continue;
		}

		for (const field of ['socket', 'session'] as const) {
			if (!isNonEmptyString(attach[field]))
				errors.push(`${prefix}.attach.${field}: required non-empty string`);
		}

		// Pappardelle launches nothing for an attach agent, so these would
		// silently do nothing.
		for (const field of ['agent_profile', 'initialization_command'] as const) {
			if (raw[field] !== undefined)
				errors.push(`${prefix}: ${field} does not apply to an attach agent`);
		}
	}

	return errors;
}

function tmuxServerArgs(socket: string): string {
	return socket.startsWith('/')
		? `-S ${quoteLaunchValue(socket)}`
		: `-L ${quoteLaunchValue(socket)}`;
}

/**
 * A nested tmux client on the agent's own server. `env -u TMUX` because the
 * pane already sits in the inner server, and tmux refuses to nest otherwise.
 * `=` makes the session target exact, so `bot` never matches `bot2`. The loop
 * attaches again whenever the client ends: when the session is down (a bot
 * that restarts, or launchd that has not started it yet) the pane says so and
 * retries, so the row shows the bot as soon as it is back. Ctrl-C while it
 * waits ends the loop and leaves the login shell (see buildShellLaunchArgs).
 */
export function buildAttachCommand(
	name: string,
	attach: PartnerAgentAttach,
): string {
	const server = tmuxServerArgs(attach.socket);
	const flag = attach.socket.startsWith('/') ? '-S' : '-L';
	const message = `${name} is not running (tmux ${flag} ${attach.socket} has no session ${attach.session}). Retrying every 5s; Ctrl-C stops.`;
	return `while :; do env -u TMUX tmux ${server} attach-session -t ${shellQuote(`=${attach.session}`)} 2>/dev/null || { printf '\\033[2J\\033[H%s\\n' ${shellQuote(message)}; sleep 5; }; done`;
}

/**
 * The launch line for a partner agent. Unlike a workspace, a partner agent
 * with no recorded session starts fresh rather than with claude's
 * `--continue`: its directory is the main repo root, where `--continue` would
 * pick up the sous-chef's conversation.
 */
export function buildPartnerLaunchCommand(
	name: string,
	agentProfile: ResolvedAgentProfile,
	options: {
		skipPermissions: boolean;
		sessionId?: string;
		initializationCommand?: string;
		/** The agent's `prompt_args` template, with `{prompt}` in it. */
		promptArgs?: string;
		/** Pass the companion rules at launch, as workspace_aware_agents does. */
		rules?: boolean;
	},
): string {
	const parts = [agentProfile.command];
	if (agentProfile.isClaude && options.skipPermissions)
		parts.push('--dangerously-skip-permissions');
	if (agentProfile.args) parts.push(agentProfile.args);
	let base =
		parts.join(' ') +
		renderAgentLaunchFlags(agentProfile) +
		(options.rules ? agentRulesFlags(agentProfile.command) : '');
	if (agentProfile.isClaude) base += ` --name ${quoteLaunchValue(name)}`;

	const init = options.initializationCommand?.trim();
	let launch = base;
	if (init) {
		const prefix = agentProfile.skillPrefix;
		const prompt = shellQuote(init.startsWith(prefix) ? init : prefix + init);
		const words = options.promptArgs?.includes('{prompt}')
			? options.promptArgs.replace('{prompt}', () => prompt)
			: prompt;
		launch = `${base} ${words}`;
	}

	const resumeArgs = options.sessionId
		? bindResumeArgs(agentProfile, options.sessionId)
		: undefined;
	if (!resumeArgs) return launch;
	return `${base} ${resumeArgs} || { printf '\\033[A\\033[2K'; false; } || ${launch}`;
}

/**
 * The session keys the startup reaper must keep: the registered workspaces
 * plus every configured partner agent, whose sessions are not in the
 * registry. A partner removed from the config is reaped like any orphan.
 */
export function keptSessionKeys(
	registered: Iterable<string>,
	config: Pick<PappardelleConfig, 'agents'> | null | undefined,
): Set<string> {
	const keys = new Set(registered);
	for (const agent of listPartnerAgents(config)) keys.add(agent.name);
	return keys;
}

/** How the TUI starts a partner agent's sessions. */
export interface PartnerSessionLaunch {
	/** The agent pane's launch line: the agent, or a nested attach. */
	command: string;
	worktreePath: string;
	agentProfile: ResolvedAgentProfile;
}

export interface PartnerSessionDeps {
	mainRepoRoot: string;
	readSessionId: (name: string, agentProfile: string) => string | undefined;
}

/** Null when `name` is not a configured partner agent. */
export function resolvePartnerSessionLaunch(
	config: PappardelleConfig,
	name: string,
	skipPermissions: boolean,
	deps: PartnerSessionDeps = defaultPartnerSessionDeps(),
): PartnerSessionLaunch | undefined {
	const agent = findPartnerAgent(config, name);
	if (!agent) return undefined;
	// An empty string falls back, as `agent_profile: ''` does on a profile.
	const agentProfileName =
		agent.agent_profile || resolveAgentProfileName(config);
	const agentProfile = getNamedAgentProfile(config, agentProfileName);
	const base = {
		worktreePath: deps.mainRepoRoot,
		agentProfile,
	};
	if (agent.attach)
		return {...base, command: buildAttachCommand(name, agent.attach)};
	const definition = config.agent_profiles?.[agentProfileName];
	const promptArgs =
		definition?.prompt_args ??
		builtinAgentDefaults(definition ?? {command: agentProfile.command})
			.prompt_args;
	return {
		...base,
		command: buildPartnerLaunchCommand(name, agentProfile, {
			skipPermissions,
			sessionId: deps.readSessionId(name, agentProfile.name),
			initializationCommand: agent.initialization_command,
			promptArgs,
			rules: workspaceAwareAgents(config),
		}),
	};
}

function defaultPartnerSessionDeps(): PartnerSessionDeps {
	const repoName = getRepoName();
	return {
		mainRepoRoot: getMainRepoRoot(),
		readSessionId: (name, agentProfile) =>
			readAgentSession(repoName, name, agentProfile),
	};
}

/**
 * The rail rows for the configured partner agents, in config order. A row
 * without an emoji of its own takes `default_emoji`, as the main row does.
 */
export function partnerAgentRows(
	config: Pick<PappardelleConfig, 'agents' | 'default_emoji'> | null,
	repoName: string,
	mainRepoRoot: string | null,
): Array<{
	name: string;
	statusKey: string;
	worktreePath: string | null;
	emoji?: string;
}> {
	return listPartnerAgents(config).map(agent => {
		const emoji = agent.emoji ?? config?.default_emoji;
		return {
			name: agent.name,
			statusKey: partnerAgentStatusKey(repoName, agent.name),
			worktreePath: mainRepoRoot,
			...(emoji === undefined ? {} : {emoji}),
		};
	});
}
