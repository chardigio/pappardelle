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

export function clearCache(): void {
	tracker().clearCache();
}
