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

/**
 * Filter spaces by a search query, matching against issue key and title.
 *
 * Returns the filtered list and a mapping from filtered index → original index.
 * Pure function — no side effects, easy to test.
 */
export function filterSpaces(
	spaces: SpaceData[],
	query: string,
): {filtered: SpaceData[]; indexMap: number[]} {
	if (!query) {
		return {
			filtered: spaces,
			indexMap: spaces.map((_, i) => i),
		};
	}
	const q = query.toLowerCase();
	const filtered: SpaceData[] = [];
	const indexMap: number[] = [];
	for (let i = 0; i < spaces.length; i++) {
		const space = spaces[i]!;
		const nameMatch = space.name.toLowerCase().includes(q);
		const titleMatch = space.linearIssue?.title?.toLowerCase().includes(q);
		if (nameMatch || titleMatch) {
			filtered.push(space);
			indexMap.push(i);
		}
	}
	return {filtered, indexMap};
}

/**
 * Kill a space's tmux sessions, then unregister it. STA-1420: the order is
 * load-bearing — if the kill fails we must NOT touch the registry, otherwise
 * it advertises "closed" while the inner-socket session is still alive.
 * Post-STA-1416 there's no `seedFromTmux` reaper to recover from that
 * mistake; the orphan would linger until manually killed.
 *
 * Returns true if the space was fully torn down (kill succeeded and registry
 * was updated). On false, caller should leave selection state untouched so
 * the user can retry.
 */
export async function tearDownSpace(
	issueKey: string,
	deps: {
		killSpaceSessions: (key: string) => Promise<boolean>;
		removeSpace: (key: string) => void | Promise<void>;
		onKillFailure: (key: string) => void;
		cleanup?: (key: string) => Promise<boolean>;
	},
): Promise<boolean> {
	const killed = await deps.killSpaceSessions(issueKey);
	if (!killed) {
		deps.onKillFailure(issueKey);
		return false;
	}
	await deps.removeSpace(issueKey);
	void deps.cleanup?.(issueKey).catch((err: unknown) => {
		log.error(
			`Failed to clean up simulator for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
	});
	return true;
}
