import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {ClaudeStatusDao} from './claude-status.ts';

type StatusReader = Pick<ClaudeStatusDao, 'readState'>;

/**
 * Whether the status record has the space's agent as started since `since`.
 * Only a running agent fires hooks, and the record keeps just the latest
 * event, so any event but SessionEnd counts: a later one can replace
 * SessionStart before the next poll. Status files are named by issue key
 * alone, so the cwd tells this repo's space apart from another repo's with
 * the same key.
 */
async function agentStarted(
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
}): Promise<boolean> {
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		if (
			await agentStarted(
				options.claudeStatus,
				options.statusKey,
				options.worktree,
				options.since,
			)
		)
			return true;
		if (Date.now() >= deadline) return false;
		await delay(options.pollMs ?? 500);
	}
}
