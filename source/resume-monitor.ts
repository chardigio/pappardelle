// The OSC 7577 side of a pane's monitor: it keeps the pane's records while
// the pane runs, and decides what happens to them when the monitor stops.

import type {Buffer} from 'node:buffer';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createLogger} from './logger.ts';
import {systemProcesses, type ProcessInspector} from './process-tree.ts';
import {
	parseResumePaneId,
	ResumeRecords,
	resumePaneId,
	verifyResumeReport,
	type ResumePane,
	type ResumeTimers,
} from './program-resume.ts';
import {readOneShot, type PaneLaunch} from './resume-launch.ts';
import {
	SqliteResumeRecordDao,
	tokenHash,
	type ResumeRecordDao,
} from './resume-records-sqlite.ts';
import {internalEntryCommand} from './runtime.ts';
import {openStateDb} from './state-db.ts';
import {tmuxFormatLiteral} from './tmux-format.ts';
import {
	LIVENESS_CHECK_MS,
	realTimers,
	shellQuoteStatus,
	statusSocket,
} from './program-status-monitor.ts';
import {
	TerminalStatusParser,
	type TerminalStatusEvent,
} from './program-status.ts';

const log = createLogger('program-resume');

const SAVE_RETRIES = 20;
const SAVE_RETRY_MS = 250;

/** At most one owner check a second for prompt marks, which any output can send. */
const PROMPT_CHECK_MS = 1000;

/** What a monitor's argv carries for its pane's records. */
export type ResumeWatchArgs = {
	repo: string;
	key: string;
	pane: ResumePane;
	panePid: number;
	/** To tell a closed pane from a dead server. */
	tmuxPaneId: string;
	tmuxSocket: string;
	monitorTokenFile: string;
	dbPath: string;
};

export function resumeWatchArgv(args: ResumeWatchArgs): string[] {
	return [
		resumePaneId(args.pane),
		String(args.panePid),
		args.tmuxPaneId,
		args.tmuxSocket,
		args.monitorTokenFile,
		args.dbPath,
	];
}

export function parseResumeWatchArgv(
	repo: string,
	key: string,
	argv: string[],
): ResumeWatchArgs | undefined {
	const [paneArg, panePid, tmuxPaneId, tmuxSocket, monitorTokenFile, dbPath] =
		argv;
	const pane = paneArg ? parseResumePaneId(paneArg) : undefined;
	if (
		!pane ||
		!/^\d+$/.test(panePid ?? '') ||
		!tmuxPaneId ||
		!tmuxSocket ||
		!monitorTokenFile ||
		!dbPath
	)
		return undefined;
	return {
		repo,
		key,
		pane,
		panePid: Number(panePid),
		tmuxPaneId,
		tmuxSocket,
		monitorTokenFile,
		dbPath,
	};
}

/**
 * The pipe-pane command of a companion pane's monitor. tmux fills in the
 * pane's pid and id when it starts it.
 */
export function resumeMonitorCommand(args: {
	repo: string;
	key: string;
	launch: Pick<PaneLaunch, 'pane' | 'monitorTokenFile'>;
	dbPath: string;
}): string {
	const words = (values: string[]) =>
		values
			.map(value =>
				tmuxFormatLiteral(shellQuoteStatus(value).replaceAll('%', '%%')),
			)
			.join(' ');
	return [
		words([
			...internalEntryCommand(
				'--internal-status-monitor',
				'program-status-monitor-cli',
			),
			'resume-watch',
			args.repo,
			args.key,
			resumePaneId(args.launch.pane),
		]),
		"'#{pane_pid}' '#{pane_id}'",
		words([statusSocket(), args.launch.monitorTokenFile, args.dbPath]),
	].join(' ');
}

/** Why a monitor stopped: its pipe closed, or it was signalled. */
export type MonitorStop = 'eof' | 'signal';

export type ResumeWatcher = {
	event(event: TerminalStatusEvent): void;
	tick(): void;
	stop(why: MonitorStop): void;
};

export type ResumeWatchDeps = {
	dao?: ResumeRecordDao;
	inspector?: ProcessInspector;
	timers?: ResumeTimers;
	now?: () => number;
	uid?: number;
	/** Whether the tmux server answers, and whether the pane is still in it. */
	paneState?: () => PaneState;
};

type PaneState = 'server-gone' | 'pane-gone' | 'present';

function tmuxPaneState(socket: string, paneId: string) {
	return (): PaneState => {
		const flag = socket.startsWith('/') ? '-S' : '-L';
		const tmux = (...args: string[]) =>
			spawnSync('tmux', [flag, socket, ...args], {encoding: 'utf8'});
		if (tmux('list-sessions', '-F', '#{session_id}').status !== 0)
			return 'server-gone';
		const pane = tmux('display-message', '-p', '-t', paneId, '#{pane_id}');
		return pane.status === 0 && pane.stdout.trim() === paneId
			? 'present'
			: 'pane-gone';
	};
}

const inertWatcher: ResumeWatcher = {
	event() {},
	tick() {},
	stop() {},
};

export function watchResume(
	args: ResumeWatchArgs,
	deps: ResumeWatchDeps = {},
): ResumeWatcher {
	const label = `${args.key} ${resumePaneId(args.pane)}`;
	// A launch commits its token to the database before the monitor reads, so
	// without one there is nothing to restore and nowhere to save, and opening
	// it would make the database of a space that is gone.
	if (!deps.dao && !existsSync(args.dbPath)) return inertWatcher;
	// A monitor attached again after its launch finds no token: it records
	// nothing new until the next launch, but still keeps the pane's stored
	// records, dropping them as their owners exit or the pane closes.
	const token = readOneShot(args.monitorTokenFile);
	const dao =
		deps.dao ??
		new SqliteResumeRecordDao(() => openStateDb(args.dbPath), args.repo);
	const hash = token ? tokenHash(token) : dao.launchHash(args.key, args.pane);
	const now = deps.now ?? (() => Date.now());
	const timers = deps.timers ?? realTimers;
	let retries = 0;
	let retryPending = false;
	// A companion pane's monitor starts with its pane, a moment before the
	// launch makes its token the pane's current one, so a save that finds
	// another token is tried again for a while. After that a newer launch
	// owns the pane.
	const save = (state: Parameters<ResumeRecordDao['save']>[3]) => {
		if (!hash) return;
		dao
			.save(args.key, args.pane, hash, state)
			.then(saved => {
				if (saved) {
					retries = SAVE_RETRIES;
					return;
				}
				if (retries >= SAVE_RETRIES || retryPending) return;
				retries++;
				retryPending = true;
				timers.after(SAVE_RETRY_MS, () => {
					retryPending = false;
					save(records.state());
				});
			})
			.catch((error: unknown) => {
				log.warn(
					`Could not save the resume records of ${label}`,
					error instanceof Error ? error : undefined,
				);
			});
	};
	const records = new ResumeRecords({
		panePid: args.panePid,
		uid: deps.uid ?? process.getuid!(),
		inspector: deps.inspector ?? systemProcesses,
		timers,
		save,
		initial: dao.read(args.key, args.pane),
	});
	const paneState =
		deps.paneState ?? tmuxPaneState(args.tmuxSocket, args.tmuxPaneId);
	let lastPromptCheck = Number.NEGATIVE_INFINITY;
	let stopped = false;
	return {
		event(event) {
			if (stopped) return;
			if (event.type === 'resume') {
				if (!token) return;
				const outcome = records.handle(
					verifyResumeReport(event.body, token, Math.floor(now() / 1000)),
				);
				log.debug(`OSC 7577 in ${label}: ${outcome}`);
			} else if (
				event.type === 'prompt' &&
				now() - lastPromptCheck >= PROMPT_CHECK_MS
			) {
				lastPromptCheck = now();
				records.checkOwners();
			}
		},
		tick() {
			if (!stopped) records.checkOwners();
		},
		stop(why) {
			if (stopped) return;
			stopped = true;
			records.stop();
			// A signal comes at logout or shutdown, when the records are what
			// brings the pane back. A closed pipe on a server that still answers
			// is a pane closed on purpose.
			if (why === 'signal') return;
			const state = paneState();
			if (state === 'server-gone') return;
			log.debug(
				`Resume records of ${label} dropped: the pane closed (${state})`,
			);
			save({records: [], times: {}});
		},
	};
}

/**
 * A companion pane's monitor: it reads the pane's output for OSC 7577 and
 * prompt marks only, and publishes no program status.
 */
export function monitorResumePane(
	watcher: ResumeWatcher,
	panePid: number,
): void {
	const parser = new TerminalStatusParser(event => {
		watcher.event(event);
	});
	const stop = (why: MonitorStop) => {
		clearInterval(liveness);
		watcher.stop(why);
		process.stdin.destroy();
	};
	// respawn-pane -k leaves the pipe open, so no EOF arrives for it.
	const liveness = setInterval(() => {
		watcher.tick();
		try {
			process.kill(panePid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') stop('eof');
		}
	}, LIVENESS_CHECK_MS);
	process.stdin.on('data', (bytes: Buffer) => {
		parser.feed(bytes);
	});
	process.stdin.on('end', () => stop('eof'));
	process.stdin.on('error', () => stop('eof'));
	process.once('SIGTERM', () => stop('signal'));
	process.once('SIGHUP', () => stop('signal'));
}
