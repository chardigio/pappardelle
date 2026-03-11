// Issue watchlist — polls the issue tracker for assigned issues with matching statuses
// and determines which ones need new workspaces spawned.
import type {TrackerIssue} from './providers/types.ts';

/**
 * Filter discovered issues to only those that don't already have workspaces.
 * Pure function — no side effects.
 */
export function getNewWatchlistIssues(
	discoveredIssues: TrackerIssue[],
	existingSpaceNames: string[],
): TrackerIssue[] {
	const existingSet = new Set(existingSpaceNames.map(n => n.toUpperCase()));

	return discoveredIssues.filter(
		issue => !existingSet.has(issue.identifier.toUpperCase()),
	);
}
