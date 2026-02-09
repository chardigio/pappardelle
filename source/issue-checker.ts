// Utility to check if an issue has an associated PR with commits
// Delegates to VcsHostProvider — thin facade for backwards compatibility.
import {createVcsHost} from './providers/index.ts';
import type {PRInfo} from './providers/types.ts';

export type {PRInfo} from './providers/types.ts';

// Re-export pure utility functions for backwards compatibility
export {
	isLinearIssueKey,
	isIssueNumber,
	normalizeIssueIdentifier,
} from './issue-utils.js';

/**
 * Check if an issue has an associated PR with commits.
 * Delegates to the configured VCS host provider.
 */
export function checkIssueHasPRWithCommits(issueKey: string): PRInfo {
	return createVcsHost().checkIssueHasPRWithCommits(issueKey);
}
