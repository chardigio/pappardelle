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

/**
 * Filter issues to only those with at least one of the specified labels.
 * Matching is case-insensitive.
 * Returns all issues if the labels array is empty.
 * Pure function — no side effects.
 */
export function filterByLabels(
	issues: TrackerIssue[],
	labels: string[],
): TrackerIssue[] {
	if (labels.length === 0) return issues;
	const labelSet = new Set(labels.map(l => l.toLowerCase()));
	return issues.filter(issue =>
		(issue.labels ?? []).some(l => labelSet.has(l.toLowerCase())),
	);
}
