// The real dependencies of the supervision verbs: this machine's tmux, clock,
// timers and environment. Read once here, so the verbs stay testable.

import {spawnSync} from 'node:child_process';
import {homedir, tmpdir, userInfo} from 'node:os';
import path from 'node:path';
import {classifyCommand, defaultClassifierRun} from './approve-classifier.ts';
import {
	getHookStatusDir,
	hookStatusKey,
	readableHookStatusKey,
} from './claude-status.ts';
import {getMainRepoRoot, getRepoName, loadConfig} from './config.ts';
import {
	attachedPartnerSessions,
	type PartnerAgentAttach,
} from './partner-agents.ts';
import {waitForDirChange} from './file-watch.ts';
import {programStatusDir} from './program-status-monitor.ts';
import {selfLaunchArgs} from './runtime.ts';
import {defaultScheduleStore, rearmMissingTimers} from './schedule.ts';
import {
	launchdBackend,
	systemdBackend,
	type TimerBackend,
	type TimerContext,
} from './schedule-timers.ts';
import {defaultReadStdin, type SuperviseDeps} from './supervise-command.ts';
import {callerFromEnv, recordSupervision} from './supervise-log.ts';
import {createLogger} from './logger.ts';
import {
	exactSessionTarget,
	getMainWorktreeInfo,
	getSessionNames,
	resolveInnerSessionTargetSync,
	sendKeysToSpaceAgent,
	type AgentSessionTarget,
	type OuterTmuxRunner,
	type SendTmuxRunner,
	type SendToSpaceAgentResult,
	sendToSpaceAgent,
	socketSendRunner,
	supervisedInnerTmuxRunner,
	supervisedServerTmuxRunner,
	supervisedSocketTmuxRunner,
} from './tmux.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

const log = createLogger('supervise');

// Timer services start with a bare environment; these decide which tmux
// server and status files `pappardelle` reaches when one fires.
const PASSED_TO_TIMERS = [
	'PATH',
	'TMUX_TMPDIR',
	'PAPPARDELLE_TMUX_SOCKET',
	'PAPPARDELLE_STATUS_DIR',
	'PAPPARDELLE_PROGRAM_STATUS_DIR',
];

function timerBackend(): TimerBackend {
	const env = Object.fromEntries(
		PASSED_TO_TIMERS.flatMap(name => {
			const value = process.env[name];
			return value ? [[name, value]] : [];
		}),
	);
	const context: TimerContext = {
		repo: getRepoName(),
		cwd: getMainRepoRoot(),
		launch: [process.execPath, ...selfLaunchArgs()],
		env,
		run(command, args) {
			const result = spawnSync(command, args, {encoding: 'utf8'});
			return {
				status: result.status,
				stderr: result.stderr ?? result.error?.message ?? '',
			};
		},
	};
	if (process.platform === 'linux') return systemdBackend(context);
	if (process.platform === 'darwin') {
		return launchdBackend({...context, home: homedir(), uid: userInfo().uid});
	}

	throw new Error(`Scheduling isn't supported on ${process.platform}`);
}

let attachedSessions: Map<string, PartnerAgentAttach> | undefined;

/**
 * The attach partner agents, read from the config once per command. A config
 * that doesn't load leaves none, so every key is a space as before.
 */
function attachedPartners(): Map<string, PartnerAgentAttach> {
	if (!attachedSessions) {
		try {
			attachedSessions = attachedPartnerSessions(loadConfig());
		} catch {
			attachedSessions = new Map();
		}
	}

	return attachedSessions;
}

/**
 * Where an attach partner's agent runs: its session on its own tmux server.
 * Undefined for every other key, whose agent is its inner session.
 */
export function locateAgent(key: string): AgentSessionTarget | undefined {
	const attach = attachedPartners().get(key);
	return attach
		? {
				session: attach.session,
				runner: supervisedSocketTmuxRunner(attach.socket),
			}
		: undefined;
}

/** The attach partners whose sessions are up, for watching every space. */
function runningAttachedKeys(): string[] {
	return [...attachedPartners()].flatMap(([key, attach]) =>
		supervisedSocketTmuxRunner(attach.socket)([
			'has-session',
			'-t',
			exactSessionTarget(attach.session),
		]).status === 0
			? [key]
			: [],
	);
}

/** `pappardelle send`'s runner and session for a key's agent. */
export function agentSendTarget(key: string): {
	runner?: SendTmuxRunner;
	session?: string;
} {
	const attach = attachedPartners().get(key);
	return attach
		? {runner: socketSendRunner(attach.socket), session: attach.session}
		: {};
}

/** `pappardelle send --keys`'s runner and session for a key's agent. */
export function agentKeysTarget(
	key: string,
	fallback: OuterTmuxRunner,
): {runner: OuterTmuxRunner; session?: string} {
	return locateAgent(key) ?? {runner: fallback};
}

function agentCwd(key: string): string | null {
	const {runner, session} = agentKeysTarget(key, supervisedInnerTmuxRunner);
	const target = resolveInnerSessionTargetSync(
		session ?? getSessionNames(key).agent,
		runner,
	);
	if (!target) return null;
	const result = runner([
		'display-message',
		'-p',
		'-t',
		target,
		'#{pane_current_path}',
	]);
	return result.status === 0 ? result.stdout.trim() || null : null;
}

function scratchRoots(): string[] {
	const claude = `claude-${userInfo().uid}`;
	return [
		'/tmp/q-',
		'/private/tmp/q-',
		`/tmp/${claude}/`,
		`/private/tmp/${claude}/`,
		`${path.join(tmpdir(), claude)}/`,
	];
}

/** Run as the TUI starts, so wake-ups lost to a reboot come back. */
export function rearmSchedules(): void {
	try {
		const store = defaultScheduleStore(getRepoName());
		for (const job of rearmMissingTimers(store, timerBackend(), new Date())) {
			recordSupervision(
				getRepoName(),
				'tui',
				{
					action: 'schedule',
					key: job.key,
					detail: `re-armed ${job.id}, its timer was gone`,
				},
				new Date(),
			);
		}
	} catch (error) {
		log.warn('Could not re-arm scheduled wake-ups', error as Error);
	}
}

const keyOutcome = (result: SendToSpaceAgentResult) =>
	result === 'sent' || result === 'no-session' ? result : 'failed';

export function defaultSuperviseDeps(
	resolveKey: (raw: string) => string,
): SuperviseDeps {
	return {
		repo: getRepoName,
		resolveKey,
		async hookKey(key) {
			if (key !== MAIN_WORKTREE_KEY)
				return readableHookStatusKey(getRepoName(), key);
			const main = await getMainWorktreeInfo();
			return hookStatusKey(getRepoName(), main?.branch ?? MAIN_WORKTREE_KEY);
		},
		runner: supervisedInnerTmuxRunner,
		serverRunner: supervisedServerTmuxRunner,
		now: () => new Date(),
		async sleep(ms) {
			await new Promise(resolve => {
				setTimeout(resolve, ms);
			});
		},
		async waitForStatusChange(ms) {
			await waitForDirChange(
				[getHookStatusDir(), programStatusDir(getRepoName())],
				ms,
			);
		},
		async send(key, text) {
			return sendToSpaceAgent(key, text, agentSendTarget(key));
		},
		sendKeys(key, keys) {
			const result = sendKeysToSpaceAgent(key, keys, {
				...agentKeysTarget(key, supervisedInnerTmuxRunner),
				answering: true,
			});
			return keyOutcome(result);
		},
		typeText(key, text) {
			const result = sendKeysToSpaceAgent(key, [text], {
				...agentKeysTarget(key, supervisedInnerTmuxRunner),
				answering: true,
				literal: true,
			});
			return keyOutcome(result);
		},
		locate: locateAgent,
		externalAgentKeys: runningAttachedKeys,
		async classify(key, command) {
			return classifyCommand(
				{command, cwd: agentCwd(key), scratchRoots: scratchRoots()},
				defaultClassifierRun,
			);
		},
		policy: {scratchRoots: scratchRoots()},
		store: () => defaultScheduleStore(getRepoName()),
		timers: timerBackend,
		caller: callerFromEnv(process.env),
		readStdin: defaultReadStdin,
		out(text) {
			console.log(text);
		},
		err(text) {
			console.error(text);
		},
	};
}
