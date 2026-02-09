// GitLab VCS host provider — wraps glab CLI
import {execFileSync} from 'node:child_process';
import {createLogger} from '../logger.ts';
import type {PRInfo, VcsHostProvider} from './types.ts';

const log = createLogger('gitlab-provider');

export class GitLabProvider implements VcsHostProvider {
	readonly name = 'gitlab';
	private readonly host?: string;

	constructor(host?: string) {
		this.host = host;
		// Set GITLAB_HOST env for self-hosted instances so glab picks it up
		if (host) {
			process.env['GITLAB_HOST'] = host;
		}
	}

	checkIssueHasPRWithCommits(issueKey: string): PRInfo {
		try {
			// GitLab doesn't store MR links in issue tracker attachments like Linear.
			// Discover MR by branch name (branch name matches issue key).
			const mrOutput = execFileSync(
				'glab',
				['mr', 'list', '--source-branch', issueKey, '--json'],
				{encoding: 'utf-8', timeout: 10_000},
			);
			const mrs = JSON.parse(mrOutput) as Array<{
				iid: number;
				web_url: string;
			}>;

			if (mrs.length === 0) {
				return {hasPR: false, hasCommits: false};
			}

			const mr = mrs[0]!;

			// Check if MR has file changes via diff
			try {
				const diffOutput = execFileSync(
					'glab',
					['mr', 'diff', String(mr.iid), '--color=never'],
					{encoding: 'utf-8', timeout: 15_000},
				);
				// Count diff file headers (lines starting with "diff --git")
				const fileCount = (diffOutput.match(/^diff --git/gm) ?? []).length;

				log.debug(
					`Issue ${issueKey} has MR !${mr.iid} with ${fileCount} files changed`,
				);
				return {
					hasPR: true,
					hasCommits: fileCount > 0,
					prNumber: mr.iid,
					prUrl: mr.web_url,
				};
			} catch (err) {
				log.warn(
					`Failed to check MR diff for ${issueKey}`,
					err instanceof Error ? err : undefined,
				);
				return {hasPR: true, hasCommits: false, prUrl: mr.web_url};
			}
		} catch (err) {
			log.warn(
				`Failed to check issue ${issueKey} for MR`,
				err instanceof Error ? err : undefined,
			);
			return {hasPR: false, hasCommits: false};
		}
	}

	buildPRUrl(prNumber: number): string {
		const host = this.host ?? 'gitlab.com';
		return `https://${host}/-/merge_requests/${prNumber}`;
	}
}
