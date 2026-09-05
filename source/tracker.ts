// Issue tracker facade — thin wrapper over IssueTrackerProvider
// All exports preserved for backwards compatibility.
import {createIssueTracker} from './providers/index.ts';
import type {TrackerIssue} from './providers/types.ts';

// Re-export TrackerIssue as LinearIssue for callers that import from here
export type {TrackerIssue as LinearIssue} from './providers/types.ts';

function tracker() {
	return createIssueTracker();
}

export async function getIssue(issueKey: string): Promise<TrackerIssue | null> {
	return tracker().getIssue(issueKey);
}

export function getIssueCached(issueKey: string): TrackerIssue | null {
	return tracker().getIssueCached(issueKey);
}

export function getWorkflowStateColor(stateName: string): string | null {
	return tracker().getWorkflowStateColor(stateName);
}

export async function getIssues(
	issueKeys: string[],
): Promise<Map<string, TrackerIssue | null>> {
	return tracker().getIssues(issueKeys);
}

export async function searchAssignedIssues(
	assignee: string | undefined,
	statuses: string[],
): Promise<TrackerIssue[]> {
	return tracker().searchAssignedIssues(assignee, statuses);
}

export function clearCache(): void {
	tracker().clearCache();
}

/**
 * Claim an issue, for trackers that support it. Resolves false rather than
 * throwing on every failure path — no tracker configured, tracker without the
 * capability, or the claim itself failing — because the sole caller is starting
 * a workspace and must not be blocked by a bookkeeping step.
 */
export async function claimIssue(issueKey: string): Promise<boolean> {
	try {
		const provider = tracker();
		if (!provider.claimIssue) return false;
		return await provider.claimIssue(issueKey);
	} catch {
		return false;
	}
}
