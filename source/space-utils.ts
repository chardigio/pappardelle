import type {SpaceData} from './types.ts';

/**
 * Hardcoded key used for the always-pinned main-worktree row in app.tsx and
 * for its tmux sessions (`claude-{repo}-main`, `lazygit-{repo}-main`). Kept
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
 * Compute the new spaces array and selected index after deleting a space.
 *
 * Pure function — no side effects, easy to test.
 */
export function computePostDeleteState(
	spaces: SpaceData[],
	deletedName: string,
	selectedIndex: number,
): {filteredSpaces: SpaceData[]; newSelectedIndex: number} {
	const filteredSpaces = spaces.filter(s => s.name !== deletedName);
	const newSelectedIndex =
		selectedIndex >= filteredSpaces.length && selectedIndex > 0
			? selectedIndex - 1
			: selectedIndex;
	return {filteredSpaces, newSelectedIndex};
}

/**
 * Whether the selection-change effect should (re)attach to `selectedSpaceName`.
 *
 * STA-1553 teardown→respawn guard. When the user closes the space they're
 * currently viewing, the close handler nulls `currentSpace` and prunes the
 * spaces list in separate renders. In the window between those two updates the
 * effect would otherwise see `currentSpace === null` with the just-closed space
 * still selected — and `attachToSpace`, which recreates inner sessions on
 * demand, would respawn the sessions teardown just killed, leaving them
 * orphaned for the next startup's reaper (the "reaped N…" banner). A space whose
 * teardown is in flight is held in `closingSpaces` and must never be reattached;
 * we also skip when it's already the shown space (nothing to do).
 *
 * Pure function — no side effects, easy to test.
 */
export function shouldAttachOnSelection(params: {
	selectedSpaceName: string;
	currentSpace: string | null;
	closingSpaces: ReadonlySet<string>;
}): boolean {
	const {selectedSpaceName, currentSpace, closingSpaces} = params;
	if (currentSpace === selectedSpaceName) return false;
	if (closingSpaces.has(selectedSpaceName)) return false;
	return true;
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
export function tearDownSpace(
	issueKey: string,
	deps: {
		killSpaceSessions: (key: string) => boolean;
		removeSpace: (key: string) => void;
		onKillFailure: (key: string) => void;
	},
): boolean {
	const killed = deps.killSpaceSessions(issueKey);
	if (!killed) {
		deps.onKillFailure(issueKey);
		return false;
	}
	deps.removeSpace(issueKey);
	return true;
}
