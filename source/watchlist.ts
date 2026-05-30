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

/**
 * Filter issues to only those whose issue-key prefix is in the allowlist.
 * The prefix is the part before the first '-' (e.g. "STA" in "STA-123").
 * Matching is case-insensitive. Returns all issues when the prefixes array is
 * empty (or contains only blanks), so an absent/empty config watches every
 * prefix — identical to behavior before this option existed.
 *
 * A malformed identifier with no '-' yields its whole string as the "prefix",
 * which won't match any normal allowlist entry, so it is excluded. That's the
 * correct conservative behavior for an allowlist: when the prefix can't be
 * determined, don't spawn a workspace for it.
 * Pure function — no side effects.
 */
export function filterByKeyPrefixes(
	issues: TrackerIssue[],
	prefixes: string[],
): TrackerIssue[] {
	const prefixSet = new Set(
		prefixes.map(p => p.trim().toUpperCase()).filter(p => p !== ''),
	);
	if (prefixSet.size === 0) return issues;
	return issues.filter(issue =>
		prefixSet.has(issue.identifier.split('-')[0]!.toUpperCase()),
	);
}
