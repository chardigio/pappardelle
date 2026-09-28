// GitLab VCS host provider — wraps glab CLI
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLogger} from '../logger.ts';
import type {PRInfo, PRLink, RailStatus, VcsHostProvider} from './types.ts';

const log = createLogger('gitlab-provider');
const execFileAsync = promisify(execFile);

export type GlabExecutor = (args: string[]) => Promise<string>;

export class GitLabProvider implements VcsHostProvider {
	get name() {
		return 'gitlab';
	}

	private readonly host?: string;
	private readonly executor: GlabExecutor;

	constructor(host?: string, executor?: GlabExecutor) {
		this.host = host;
		this.executor =
			executor ??
			(async args => {
				const {stdout} = await execFileAsync('glab', args, {
					encoding: 'utf-8',
					timeout: 15_000,
					env: {...process.env, ...(host ? {GITLAB_HOST: host} : {})},
				});
				return stdout;
			});
	}

	async getPRLink(issueKey: string): Promise<PRLink | null> {
		// GitLab doesn't store MR links in issue tracker attachments like Linear.
		// Discover MR by branch name (branch name matches issue key).
		const mrOutput = await this.executor([
			'mr',
			'list',
			'--source-branch',
			issueKey,
			'-F',
			'json',
		]);
		const mrs = JSON.parse(mrOutput) as Array<{
			iid: number;
			web_url: string;
		}>;

		const mr = mrs[0];
		return mr ? {number: mr.iid, url: mr.web_url} : null;
	}

	async checkIssueHasPRWithCommits(issueKey: string): Promise<PRInfo> {
		try {
			const mr = await this.getPRLink(issueKey);
			if (!mr) return {hasPR: false, hasCommits: false};

			// Check if MR has file changes via diff
			try {
				const diffOutput = await this.executor([
					'mr',
					'diff',
					String(mr.number),
					'--color=never',
				]);
				// Count diff file headers (lines starting with "diff --git")
				const fileCount = (diffOutput.match(/^diff --git/gm) ?? []).length;

				log.debug(
					`Issue ${issueKey} has MR !${mr.number} with ${fileCount} files changed`,
				);
				return {
					hasPR: true,
					hasCommits: fileCount > 0,
					prNumber: mr.number,
					prUrl: mr.url,
				};
			} catch (err) {
				log.warn(
					`Failed to check MR diff for ${issueKey}`,
					err instanceof Error ? err : undefined,
				);
				return {
					hasPR: true,
					hasCommits: false,
					prNumber: mr.number,
					prUrl: mr.url,
				};
			}
		} catch (err) {
			log.warn(
				`Failed to check issue ${issueKey} for MR`,
				err instanceof Error ? err : undefined,
			);
			return {hasPR: false, hasCommits: false};
		}
	}

	async buildPRUrl(prNumber: number): Promise<string> {
		const host = this.host ?? 'gitlab.com';
		return `https://${host}/-/merge_requests/${prNumber}`;
	}

	async getRailStatus(_issueKey: string): Promise<RailStatus> {
		// Not yet implemented for GitLab. GitLab users see the rail without
		// pipeline/comment icons — identical to the pre-STA-862 behavior.
		return {pipeline: null, unresolvedCommentCount: 0};
	}

	async getBulkRailStatus(
		issueKeys: string[],
	): Promise<Map<string, RailStatus>> {
		// Not yet implemented for GitLab — return empty status for all keys.
		const empty: RailStatus = {pipeline: null, unresolvedCommentCount: 0};
		return new Map(issueKeys.map(key => [key, empty]));
	}
}
