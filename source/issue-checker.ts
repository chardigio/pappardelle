// Utility to check if an issue has an associated PR with commits
import {execSync} from 'node:child_process';
import {createLogger} from './logger.js';

// Re-export pure utility functions for backwards compatibility
export {
	isLinearIssueKey,
	isIssueNumber,
	normalizeIssueIdentifier,
} from './issue-utils.js';

const log = createLogger('issue-checker');

interface PRInfo {
	hasPR: boolean;
	hasCommits: boolean;
	prNumber?: number;
	prUrl?: string;
}

/**
 * Check if an issue has an associated PR with commits
 */
export function checkIssueHasPRWithCommits(issueKey: string): PRInfo {
	try {
		// Get issue details from Linear
		const issueOutput = execSync(`linctl issue get "${issueKey}" --json`, {
			encoding: 'utf-8',
			timeout: 10000,
		});
		const issue = JSON.parse(issueOutput);

		// Check for PR attachments
		const attachments = issue.attachments?.nodes ?? [];
		const prAttachment = attachments.find(
			(a: {url?: string; metadata?: {status?: string}}) =>
				a.url?.includes('github.com') && a.url?.includes('/pull/'),
		);

		if (!prAttachment) {
			return {hasPR: false, hasCommits: false};
		}

		// Extract PR number and repo info from URL
		// URL format: https://github.com/owner/repo/pull/123
		const prUrl = prAttachment.url as string;
		const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

		if (!match) {
			return {hasPR: true, hasCommits: false, prUrl};
		}

		const [, owner, repo, prNumber] = match;

		// Check if PR has actual file changes (not just empty placeholder commit)
		try {
			const filesOutput = execSync(
				`gh pr view ${prNumber} --repo ${owner}/${repo} --json files --jq '.files | length'`,
				{
					encoding: 'utf-8',
					timeout: 10000,
				},
			);
			const fileCount = parseInt(filesOutput.trim(), 10);

			log.debug(
				`Issue ${issueKey} has PR #${prNumber} with ${fileCount} files changed`,
			);
			return {
				hasPR: true,
				hasCommits: fileCount > 0, // "hasCommits" now means "has actual changes"
				prNumber: parseInt(prNumber!, 10),
				prUrl,
			};
		} catch (err) {
			// If gh fails, assume PR exists but can't verify changes
			log.warn(
				`Failed to check PR files for ${issueKey}`,
				err instanceof Error ? err : undefined,
			);
			return {hasPR: true, hasCommits: false, prUrl};
		}
	} catch (err) {
		log.warn(
			`Failed to check issue ${issueKey} for PR`,
			err instanceof Error ? err : undefined,
		);
		return {hasPR: false, hasCommits: false};
	}
}
