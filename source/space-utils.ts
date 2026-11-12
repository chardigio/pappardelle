import type {SpaceData} from './types.ts';
import {createLogger} from './logger.ts';

const log = createLogger('space-utils');

/**
 * Hardcoded key used for the always-pinned main-worktree row in app.tsx and
 * for its tmux sessions (`agent-{repo}-main`, `lazygit-{repo}-main`). Kept
 * as a shared constant so the inner-socket reaper's "never kill main" check
 * stays coupled to wherever the row's name is set — renaming the row without
 * updating the reaper would silently start reaping the main worktree's
 * sessions on every startup.
 */
export const MAIN_WORKTREE_KEY = 'main';

/**
 * Whether the space list item should show "Loading…" as its title.
 *
 * Returns true when the Linear issue title hasn't been fetched yet
 * for a real (non-pending, non-main-worktree) space with a name.
 */
export function shouldShowLoadingTitle(space: SpaceData): boolean {
	return (
		!space.pendingTitle &&
		!space.linearIssue?.title &&
		!space.isMainWorktree &&
		space.name.length > 0
	);
}

export type TearDownResult =
	| {outcome: 'closed'}
	/** Nothing was touched: the close could not be recorded as started. */
	| {outcome: 'mark-failed'; error: unknown}
	/** The sessions are still running and the space is still open. */
	| {outcome: 'kill-failed'}
	/** The sessions are gone and the registry still has the space. */
	| {outcome: 'unregister-failed'; error: unknown};

/**
 * Kill a space's tmux sessions, then unregister it. STA-1420: the order is
 * load-bearing — if the kill fails we must NOT touch the registry, otherwise
 * it advertises "closed" while the inner-socket session is still alive.
 * Post-STA-1416 there's no `seedFromTmux` reaper to recover from that
 * mistake; the orphan would linger until manually killed.
 *
 * A registry that records a close in progress is told before the kill, so a
 * removal that then fails leaves a space known to be closing: one that
 * nothing reattaches to or respawns.
 *
 * On anything but `closed`, the caller should leave selection state
 * untouched so the user can retry.
 */
export async function tearDownSpace(
	issueKey: string,
	deps: {
		markClosing: (key: string) => Promise<void>;
		reopen: (key: string) => Promise<void>;
		killSpaceSessions: (key: string) => Promise<boolean>;
		removeSpace: (key: string) => void | Promise<void>;
		onKillFailure: (key: string) => void;
		cleanup?: (key: string) => Promise<boolean>;
	},
): Promise<TearDownResult> {
	try {
		await deps.markClosing(issueKey);
	} catch (error) {
		return {outcome: 'mark-failed', error};
	}

	const killed = await deps.killSpaceSessions(issueKey);
	if (!killed) {
		await deps.reopen(issueKey).catch((error: unknown) => {
			log.error(
				`Failed to reopen ${issueKey} after its sessions could not be killed`,
				error instanceof Error ? error : undefined,
			);
		});
		deps.onKillFailure(issueKey);
		return {outcome: 'kill-failed'};
	}

	try {
		await deps.removeSpace(issueKey);
	} catch (error) {
		return {outcome: 'unregister-failed', error};
	}

	void deps.cleanup?.(issueKey).catch((err: unknown) => {
		log.error(
			`Failed to clean up simulator for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
	});
	return {outcome: 'closed'};
}
