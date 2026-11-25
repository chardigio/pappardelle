import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pinnedStatusPaneInfo} from './agent-state.ts';
import type {ClaudeStatusDao} from './claude-status.ts';
import {
	statusTmuxArgs,
	type ProgramStatusDao,
} from './program-status-monitor.ts';
import type {SpaceIdentityDao} from './space-identity.ts';
import {defaultServerTmuxEnv, type OuterTmuxRunner} from './tmux.ts';

type StatusReader = Pick<ClaudeStatusDao, 'readState'>;

const SHELLS = new Set([
	'sh',
	'bash',
	'zsh',
	'dash',
	'fish',
	'ksh',
	'tcsh',
	'csh',
]);

function isShellCommand(command: string | undefined): boolean {
	if (!command) return true;
	const base = path.basename(command.trim()).replace(/^-/, '');
	return !base || SHELLS.has(base);
}

function socketTmuxRunner(socket: string): OuterTmuxRunner {
	const env = defaultServerTmuxEnv(process.env);
	return args =>
		spawnSync('tmux', statusTmuxArgs([...args], socket), {
			encoding: 'utf8',
			env,
		});
}

export type OscStartDeps = {
	programStatus: Pick<ProgramStatusDao, 'read'>;
	spaceIdentities: Pick<SpaceIdentityDao, 'get'>;
	issueKey: string;
	runner?: OuterTmuxRunner;
};

/**
 * Whether the Claude hook record has the space's agent as started since `since`.
 * Only a running agent fires hooks, and the record keeps just the latest
 * event, so any event but SessionEnd counts: a later one can replace
 * SessionStart before the next poll. Status files are named by issue key
 * alone, so the cwd tells this repo's space apart from another repo's with
 * the same key.
 */
async function claudeHookStarted(
	claudeStatus: StatusReader,
	statusKey: string,
	worktree: string,
	since: number,
): Promise<boolean> {
	const stored = await claudeStatus.readState(statusKey);
	if (stored.kind !== 'state') return false;
	const {event, cwd, lastUpdate} = stored.state;
	return (
		event !== undefined &&
		event !== 'SessionEnd' &&
		cwd !== undefined &&
		(cwd === worktree || cwd.startsWith(worktree + path.sep)) &&
		lastUpdate >= since
	);
}

/**
 * Whether the space's live agent pane has an authoritative OSC program-status
 * snapshot. Fresh launches confirm once the snapshot updates after `since`;
 * already-running agents opened with `--resume` also confirm when the pane is
 * not sitting at a bare shell, because an exited agent preserves the same pane
 * generation while leaving its prior `idle`/`done` snapshot in place.
 */
async function oscProgramStarted(
	osc: OscStartDeps | undefined,
	since: number,
): Promise<boolean> {
	if (!osc) return false;
	const identity = osc.spaceIdentities.get(osc.issueKey);
	if (identity.kind !== 'identity') return false;
	const {agentSession, socket} = identity.identity.tmux;
	const info = pinnedStatusPaneInfo(
		agentSession,
		osc.runner ?? socketTmuxRunner(socket),
		socket,
	);
	if (!info || info.pane.dead) return false;
	const snapshot = await osc.programStatus.read(osc.issueKey, info.pane);
	if (
		snapshot === null ||
		!snapshot.authoritative ||
		snapshot.exited ||
		snapshot.pane.generation !== info.pane.generation ||
		snapshot.info.status === 'unknown'
	) {
		return false;
	}

	if (snapshot.updatedAt >= since) return true;
	return !isShellCommand(info.currentCommand);
}

/**
 * Wait for a space's agent to start. A failed agent launch leaves a login
 * shell in the pane, and `pappardelle send` only checks that the tmux session
 * exists, so sending without this check can run the text as a shell command.
 */
export async function waitForAgentStart(options: {
	claudeStatus: StatusReader;
	statusKey: string;
	worktree: string;
	since: number;
	timeoutMs: number;
	pollMs?: number;
	osc?: OscStartDeps;
}): Promise<boolean> {
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		if (
			(await claudeHookStarted(
				options.claudeStatus,
				options.statusKey,
				options.worktree,
				options.since,
			)) ||
			(await oscProgramStarted(options.osc, options.since))
		)
			return true;
		if (Date.now() >= deadline) return false;
		await delay(options.pollMs ?? 500);
	}
}
