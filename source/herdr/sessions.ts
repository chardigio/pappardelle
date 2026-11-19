// A space's agent and companion as herdr-core terminals.
//
// The tmux versions of these live in tmux.ts and build `new-session` argument
// lists; these build terminals instead. The pieces that are not about tmux --
// the resume command, the login-shell handoff, the env a session needs -- are
// reused as they are, so an agent launched here and one launched under tmux
// run the same command.
//
// Two tmux behaviours have no herdr equivalent and are intentionally dropped:
//
//   - the startup gate (`wait-for`), which held an agent until the status
//     monitor attached. Status here is read from the terminal's screen, so
//     there is nothing to wait for.
//   - hidden status bars and `destroy-unattached`, which are about tmux's own
//     chrome and session lifecycle.

import {execFileSync} from 'node:child_process';
import {
	DEFAULT_COMPANION_COMMAND,
	DEFAULT_RESOLVED_AGENT_PROFILE,
	getRepoName,
	type AgentLaunch,
	type ResolvedAgentProfile,
} from '../config.ts';
import {installAgentRules} from '../companion-rules.ts';
import {createLogger} from '../logger.ts';
import {getAgentSessionsPath} from '../space-state.ts';
import {MAIN_WORKTREE_KEY} from '../space-utils.ts';
import {buildSessionEnvArgs, buildAgentSessionEnvArgs} from '../spawn-env.ts';
import {
	buildAgentResumeCommand,
	buildShellLaunchArgs,
	fromSessionKey,
	getSessionNames,
	getSessionPrefix,
	pretrustDirectoryForClaude,
} from '../tmux.ts';
import {
	envArgsToMap,
	findTerminal,
	isBlocked,
	killTerminal,
	listRepoTerminals,
	readScreen,
	runTerminal,
	sendKeys,
	sendKeysSync,
	sendText,
	terminalExists,
} from './terminals.ts';

const log = createLogger('herdr-sessions');

/** The env a space's terminal needs, in the map form hc takes. */
function spaceEnv(issueKey: string, repoName: string): Record<string, string> {
	// The launcher already told us the main checkout when it started the rail,
	// so this avoids a git fork per session.
	const mainRepoRoot = process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	return envArgsToMap(buildSessionEnvArgs(issueKey, repoName, mainRepoRoot));
}

function agentEnv(
	issueKey: string,
	repoName: string,
	profile: ResolvedAgentProfile,
): Record<string, string> {
	return {
		...spaceEnv(issueKey, repoName),
		...envArgsToMap(
			buildAgentSessionEnvArgs(
				profile,
				getAgentSessionsPath(repoName, issueKey),
			),
		),
	};
}

/**
 * Start a space's agent unless one is already live. Mirrors
 * `ensureAgentSession` in tmux.ts: the same resume command, the same
 * login-shell handoff, and `keep` so a lost program leaves a shell rather than
 * a dead pane.
 */
export async function ensureHerdrAgentSession(
	issueKey: string,
	worktreePath: string,
	options: {
		skipPermissions?: boolean;
		profile?: ResolvedAgentProfile;
		launch?: AgentLaunch;
		sessionId?: string;
		repoName?: string;
	} = {},
): Promise<boolean> {
	const repoName = options.repoName ?? getRepoName();
	const profile = options.profile ?? DEFAULT_RESOLVED_AGENT_PROFILE;
	const sessionName = getSessionNames(issueKey, repoName).agent;

	if (await terminalExists(sessionName)) return true;

	if (profile.isClaude) pretrustDirectoryForClaude(worktreePath);

	if (options.launch?.rules) {
		try {
			await installAgentRules(profile.command, worktreePath);
		} catch (error) {
			log.warn(
				`Could not write the companion rules for ${issueKey}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	// `buildAgentResumeCommand` already folds in the rules flag when the launch
	// asks for it, so the command is taken as it comes. That keeps an agent
	// launched here byte-identical to one launched under tmux.
	const command = buildAgentResumeCommand(
		issueKey,
		options.skipPermissions ?? false,
		profile,
		options.sessionId,
		options.launch,
	);

	try {
		await runTerminal({
			sessionName,
			kind: 'agent',
			repoName,
			argv: buildShellLaunchArgs(command, true),
			cwd: worktreePath,
			env: agentEnv(issueKey, repoName, profile),
			keep: true,
		});
		log.info(`Created agent terminal: ${sessionName}`);
		return true;
	} catch (error) {
		log.error(
			`Failed to create agent terminal for ${issueKey}`,
			error instanceof Error ? error : undefined,
		);
		return false;
	}
}

/**
 * Start a space's companion unless one is already live. An empty command
 * leaves the terminal's own shell, which is what the tmux path does too.
 */
export async function ensureHerdrCompanionSession(
	issueKey: string,
	worktreePath: string,
	options: {
		command?: string;
		repoName?: string;
	} = {},
): Promise<boolean> {
	const repoName = options.repoName ?? getRepoName();
	const sessionName = getSessionNames(issueKey, repoName).companion;
	const command = options.command ?? DEFAULT_COMPANION_COMMAND;
	if (await terminalExists(sessionName)) return true;

	try {
		await runTerminal({
			sessionName,
			kind: 'companion',
			repoName,
			...(command.trim() === '' ? {} : {argv: buildShellLaunchArgs(command)}),
			cwd: worktreePath,
			env: spaceEnv(issueKey, repoName),
			keep: true,
		});
		log.info(`Created companion terminal: ${sessionName}`);
		return true;
	} catch (error) {
		log.error(
			`Failed to create companion terminal for ${issueKey}`,
			error instanceof Error ? error : undefined,
		);
		return false;
	}
}

/** Both of a space's terminals, and the legacy name if one is still around. */
export async function killHerdrSpaceSessions(
	issueKey: string,
	repoName?: string,
): Promise<boolean> {
	const sessions = getSessionNames(issueKey, repoName);
	// Keep the agent, as the tmux path does, until the companion is gone:
	// reattaching after a companion failure must not restart the agent.
	if (!(await killTerminal(sessions.companion))) return false;

	const agentKilled = await killTerminal(sessions.agent);
	const legacyKilled = await killTerminal(sessions.legacyAgent);
	return agentKilled && legacyKilled;
}

/**
 * `pappardelle send`: submit text to a space's agent.
 *
 * hc refuses to type into a program that is waiting on an approval or a
 * question (`blocked`), which is exactly the case Pappardelle's own `prompt`
 * result covers: the keys would answer the dialog instead of reaching the
 * agent. Both report the same thing to the caller.
 */
export async function sendToHerdrAgent(
	issueKey: string,
	text: string,
	options: {repoName?: string; force?: boolean} = {},
): Promise<'sent' | 'no-session' | 'prompt' | 'failed'> {
	const sessionName = getSessionNames(issueKey, options.repoName).agent;
	const terminal = await findTerminal(sessionName);
	if (!terminal) return 'no-session';
	try {
		await sendText(sessionName, text, {force: options.force ?? false});
		return 'sent';
	} catch (error) {
		return isBlocked(error) ? 'prompt' : 'failed';
	}
}

/** `pappardelle send --keys`: press keys in a space's agent. */
export async function sendKeysToHerdrAgent(
	issueKey: string,
	keys: readonly string[],
	options: {repoName?: string} = {},
): Promise<'sent' | 'no-session' | 'prompt' | 'failed'> {
	const sessionName = getSessionNames(issueKey, options.repoName).agent;
	if (!(await terminalExists(sessionName))) return 'no-session';
	try {
		await sendKeys(sessionName, keys);
		return 'sent';
	} catch (error) {
		return isBlocked(error) ? 'prompt' : 'failed';
	}
}

/**
 * `sendKeysToHerdrAgent`, synchronously: for the supervision path, which
 * presses keys without awaiting and reports a plain outcome.
 */
export function sendKeysToHerdrAgentSync(
	issueKey: string,
	keys: readonly string[],
	options: {repoName?: string} = {},
): 'sent' | 'no-session' | 'prompt' | 'failed' {
	const sessionName = getSessionNames(issueKey, options.repoName).agent;
	try {
		sendKeysSync(sessionName, keys);
		return 'sent';
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not_found|no terminal/i.test(message)) return 'no-session';
		return /blocked/i.test(message) ? 'prompt' : 'failed';
	}
}

/**
 * The keys of every space in `repo` with a live agent, synchronously.
 *
 * hc lists terminals through the core socket, but the supervision callers that
 * ask for this run tmux synchronously, so the listing goes through the `hc`
 * CLI where a blocking spawn is acceptable.
 */
export function listHerdrAgentKeysSync(repo: string): string[] {
	let raw: string;
	try {
		raw = execFileSync(
			'hc',
			['ls', '--json', '--label', `pappardelle.repo=${repo}`],
			{encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']},
		);
	} catch {
		return [];
	}

	let parsed: {terminals?: Array<{labels?: Record<string, string>}>};
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	const prefix = getSessionPrefix('agent', repo);
	const keys: string[] = [];
	for (const terminal of parsed.terminals ?? []) {
		const session = terminal.labels?.['pappardelle.session'];
		if (!session || !session.startsWith(prefix)) continue;
		keys.push(fromSessionKey(session.slice(prefix.length)));
	}

	return keys;
}

/** A space's agent screen, for the parsers that read what it is showing. */
export async function herdrAgentScreen(
	issueKey: string,
	options: {repoName?: string; lines?: number} = {},
): Promise<string | null> {
	const sessionName = getSessionNames(issueKey, options.repoName).agent;
	if (!(await terminalExists(sessionName))) return null;
	try {
		return await readScreen(sessionName, options.lines ?? 0);
	} catch {
		return null;
	}
}

/** The live terminal a session name names, or null. */
export async function herdrTerminal(
	issueKey: string,
	kind: 'agent' | 'companion',
	repoName?: string,
): Promise<{address: string; name: string | null} | null> {
	const terminal = await findTerminal(
		getSessionNames(issueKey, repoName)[kind],
	);
	return terminal ? {address: terminal.address, name: terminal.name} : null;
}

/**
 * Terminals left behind by a space that is no longer registered: the herdr
 * equivalent of `cleanupOrphanedInnerSessions`. Only this repo's terminals are
 * considered, so a core shared with other repos is left alone there.
 */
export async function cleanupOrphanedHerdrTerminals(
	repoName: string,
	registered: ReadonlySet<string>,
): Promise<number> {
	let terminals;
	try {
		terminals = await listRepoTerminals(repoName, {all: true});
	} catch {
		return 0;
	}

	// The main worktree is not in the registry (it is always there, so it is
	// never added), and its agent is the one the rail shows on every launch.
	// Reaping it would kill the terminal the window is about to show.
	const keys = [...registered, MAIN_WORKTREE_KEY];
	let swept = 0;
	for (const terminal of terminals) {
		const session = terminal.labels['pappardelle.session'];
		if (!session) continue;
		if (keys.some(key => session.endsWith(key))) continue;
		if (await killTerminal(session)) swept++;
	}

	return swept;
}
