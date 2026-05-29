// Auto-remove spaces from the ticket rail when their tracker issue
// reaches a terminal state (completed or canceled). Triggered by the
// top-level `auto_remove_when_done` config flag.
import type {SpaceData} from './types.ts';

/**
 * The `state.type` values that count as "done" for auto-removal.
 * Mirrors Linear's workflow state types ('completed' | 'canceled') and Jira's
 * equivalents after the tracker provider normalizes them.
 */
export const AUTO_REMOVE_STATE_TYPES = new Set(['completed', 'canceled']);

/**
 * Return the subset of `spaces` whose tracker issue has entered a terminal
 * state and should be auto-removed from the rail. Pure function — the caller
 * is responsible for actually invoking the removal flow.
 *
 * Off-by-default: when `autoRemoveWhenDone` is undefined or false, returns []
 * regardless of issue state. Pinned by the regression test in
 * `auto-remove.test.ts` so adding the field can never silently change legacy
 * behavior.
 */
export function findSpacesToAutoRemove(
	spaces: SpaceData[],
	autoRemoveWhenDone: boolean | undefined,
): SpaceData[] {
	if (!autoRemoveWhenDone) return [];
	return spaces.filter(space => {
		if (space.isMainWorktree) return false;
		if (space.isPending) return false;
		const issue = space.trackerIssue ?? space.linearIssue;
		if (!issue) return false;
		return AUTO_REMOVE_STATE_TYPES.has(issue.state.type);
	});
}
