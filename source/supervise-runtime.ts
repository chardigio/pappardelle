// The real dependencies of the supervision verbs: this machine's tmux, clock,
// timers and environment. Read once here, so the verbs stay testable.

import {spawnSync} from 'node:child_process';
import {homedir, tmpdir, userInfo} from 'node:os';
import path from 'node:path';
import {classifyCommand, defaultClassifierRun} from './approve-classifier.ts';
import {hookStatusKey} from './claude-status.ts';
import {getMainRepoRoot, getRepoName} from './config.ts';
import {waitForDirChange} from './file-watch.ts';
import {programStatusDir} from './program-status-monitor.ts';
import {selfLaunchArgs} from './runtime.ts';
import {rearmMissingTimers, type ScheduleDao} from './schedule.ts';
import {
	launchdBackend,
	systemdBackend,
	type TimerBackend,
	type TimerContext,
} from './schedule-timers.ts';
import type {StateDaos} from './state-daos.ts';
import {defaultReadStdin, type SuperviseDeps} from './supervise-command.ts';
import {callerFromEnv, recordSupervision} from './supervise-log.ts';
import {createLogger} from './logger.ts';
import {
	getMainWorktreeInfo,
	getSessionNames,
	resolveInnerSessionTargetSync,
	sendKeysToSpaceAgent,
	type SendToSpaceAgentResult,
	sendToSpaceAgent,
	supervisedInnerTmuxRunner,
	supervisedServerTmuxRunner,
} from './tmux.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

const log = createLogger('supervise');

// Timer services start with a bare environment; these decide which tmux
// server, status files and state database `pappardelle` reaches when one
// fires.
const PASSED_TO_TIMERS = [
	'PATH',
	'TMUX_TMPDIR',
	'PAPPARDELLE_TMUX_SOCKET',
	'PAPPARDELLE_STATUS_DIR',
	'PAPPARDELLE_PROGRAM_STATUS_DIR',
	'PAPPARDELLE_SQLITE_STATE',
	'PAPPARDELLE_STATE_DB',
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

function agentCwd(key: string): string | null {
	const target = resolveInnerSessionTargetSync(
		getSessionNames(key).agent,
		supervisedInnerTmuxRunner,
	);
	if (!target) return null;
	const result = supervisedInnerTmuxRunner([
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
export async function rearmSchedules(schedules: ScheduleDao): Promise<void> {
	try {
		const rearmed = await rearmMissingTimers(
			schedules,
			timerBackend(),
			new Date(),
		);
		for (const job of rearmed) {
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
	{claudeStatus, schedules}: Pick<StateDaos, 'claudeStatus' | 'schedules'>,
): SuperviseDeps {
	return {
		repo: getRepoName,
		resolveKey,
		async hookKey(key) {
			if (key !== MAIN_WORKTREE_KEY)
				return claudeStatus.readableKey(getRepoName(), key);
			const main = await getMainWorktreeInfo();
			return hookStatusKey(getRepoName(), main?.branch ?? MAIN_WORKTREE_KEY);
		},
		readHook: async hookKey => claudeStatus.read(hookKey),
		runner: supervisedInnerTmuxRunner,
		serverRunner: supervisedServerTmuxRunner,
		now: () => new Date(),
		async sleep(ms) {
			await new Promise(resolve => {
				setTimeout(resolve, ms);
			});
		},
		async waitForStatusChange(ms) {
			await Promise.race([
				claudeStatus.waitForChange(ms),
				waitForDirChange([programStatusDir(getRepoName())], ms),
			]);
		},
		async send(key, text) {
			return sendToSpaceAgent(key, text);
		},
		sendKeys(key, keys) {
			const result = sendKeysToSpaceAgent(key, keys, {
				runner: supervisedInnerTmuxRunner,
				answering: true,
			});
			return keyOutcome(result);
		},
		typeText(key, text) {
			const result = sendKeysToSpaceAgent(key, [text], {
				runner: supervisedInnerTmuxRunner,
				answering: true,
				literal: true,
			});
			return keyOutcome(result);
		},
		async classify(key, command) {
			return classifyCommand(
				{command, cwd: agentCwd(key), scratchRoots: scratchRoots()},
				defaultClassifierRun,
			);
		},
		policy: {scratchRoots: scratchRoots()},
		store: () => schedules,
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
