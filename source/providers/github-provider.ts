// GitHub VCS host provider — wraps gh CLI
import {execFileSync} from 'node:child_process';
import {createLogger} from '../logger.ts';
import type {PRInfo, VcsHostProvider} from './types.ts';

const log = createLogger('github-provider');

export class GitHubProvider implements VcsHostProvider {
	readonly name = 'github';
	private repoSlug: string | null = null;

	/**
	 * Get the owner/repo slug from the current git remote.
	 * Cached after first successful call.
	 */
	private getRepoSlug(): string | null {
		if (this.repoSlug) return this.repoSlug;
		try {
			const output = execFileSync(
				'gh',
				['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
				{encoding: 'utf-8', timeout: 10_000},
			);
			this.repoSlug = output.trim();
			return this.repoSlug;
		} catch {
			return null;
		}
	}

	checkIssueHasPRWithCommits(issueKey: string): PRInfo {
		try {
			// Discover PR by branch name (branch name matches issue key).
			// This approach is tracker-agnostic — no dependency on linctl or any
			// issue tracker. Works for Linear + GitHub and Jira + GitHub alike.
			const prOutput = execFileSync(
				'gh',
				[
					'pr',
					'list',
					'--head',
					issueKey,
					'--json',
					'number,url,changedFiles',
					'--limit',
					'1',
				],
				{encoding: 'utf-8', timeout: 10_000},
			);
			const prs = JSON.parse(prOutput) as Array<{
				number: number;
				url: string;
				changedFiles: number;
			}>;

			if (prs.length === 0) {
				return {hasPR: false, hasCommits: false};
			}

			const pr = prs[0]!;
			log.debug(
				`Issue ${issueKey} has PR #${pr.number} with ${pr.changedFiles} files changed`,
			);
			return {
				hasPR: true,
				hasCommits: pr.changedFiles > 0,
				prNumber: pr.number,
				prUrl: pr.url,
			};
		} catch (err) {
			log.warn(
				`Failed to check issue ${issueKey} for PR`,
				err instanceof Error ? err : undefined,
			);
			return {hasPR: false, hasCommits: false};
		}
	}

	buildPRUrl(prNumber: number): string {
		const slug = this.getRepoSlug();
		if (slug) {
			return `https://github.com/${slug}/pull/${prNumber}`;
		}

		// Fallback — callers typically use the full URL from checkIssueHasPRWithCommits
		return `https://github.com/pull/${prNumber}`;
	}
}
