import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

/**
 * Whether the status file records the space's agent as started since `since`.
 * Only a running agent fires hooks, and the file keeps just the latest event,
 * so any event but SessionEnd counts: a later one can replace SessionStart
 * before the next poll. Status files are named by issue key alone, so the cwd
 * tells this repo's space apart from another repo's with the same key.
 */
async function agentStarted(
	statusFile: string,
	worktree: string,
	since: number,
): Promise<boolean> {
	let status: unknown;
	try {
		status = JSON.parse(await readFile(statusFile, 'utf8'));
	} catch {
		return false;
	}

	if (typeof status !== 'object' || status === null) return false;
	const {event, cwd, lastUpdate} = status as Record<string, unknown>;
	return (
		typeof event === 'string' &&
		event !== 'SessionEnd' &&
		typeof cwd === 'string' &&
		(cwd === worktree || cwd.startsWith(worktree + path.sep)) &&
		typeof lastUpdate === 'number' &&
		lastUpdate >= since
	);
}

/**
 * Wait for a space's agent to start. A failed agent launch leaves a login
 * shell in the pane, and `pappardelle send` only checks that the tmux session
 * exists, so sending without this check can run the text as a shell command.
 */
export async function waitForAgentStart(options: {
	statusFile: string;
	worktree: string;
	since: number;
	timeoutMs: number;
	pollMs?: number;
}): Promise<boolean> {
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		if (await agentStarted(options.statusFile, options.worktree, options.since))
			return true;
		if (Date.now() >= deadline) return false;
		await delay(options.pollMs ?? 500);
	}
}
