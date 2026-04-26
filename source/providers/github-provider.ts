// GitHub VCS host provider — wraps gh CLI
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createLogger} from '../logger.ts';
import {classifyPipeline, type CheckContext} from '../rail-status.ts';
import {sanitizeSubprocessError} from '../sanitize-error.ts';
import type {PRInfo, RailStatus, VcsHostProvider} from './types.ts';

const log = createLogger('github-provider');
const execFileAsync = promisify(execFile);

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
				sanitizeSubprocessError(err),
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

	async getRailStatus(issueKey: string): Promise<RailStatus> {
		const empty: RailStatus = {pipeline: null, unresolvedCommentCount: 0};
		const slug = this.getRepoSlug();
		if (!slug) return empty;

		const [owner, name] = slug.split('/');
		if (!owner || !name) return empty;

		try {
			const query = `
				query($owner: String!, $name: String!, $branch: String!) {
					repository(owner: $owner, name: $name) {
						pullRequests(headRefName: $branch, first: 1, states: OPEN) {
							nodes {
								number
								commits(last: 1) {
									nodes {
										commit {
											statusCheckRollup {
												contexts(first: 100) {
													nodes {
														__typename
														... on CheckRun {
															status
															conclusion
														}
														... on StatusContext {
															state
														}
													}
												}
											}
										}
									}
								}
								reviewThreads(first: 100) {
									nodes {
										isResolved
									}
								}
							}
						}
					}
				}
			`;

			// Async exec — execFileSync would block the Ink event loop for the
			// entire duration of the gh call (~500ms-1s), and Promise.all over N
			// spaces would make initial pappardelle startup feel frozen.
			const {stdout} = await execFileAsync(
				'gh',
				[
					'api',
					'graphql',
					'-F',
					`owner=${owner}`,
					'-F',
					`name=${name}`,
					'-F',
					`branch=${issueKey}`,
					'-f',
					`query=${query}`,
				],
				{encoding: 'utf-8', timeout: 15_000},
			);

			const parsed = JSON.parse(stdout) as {
				data?: {
					repository?: {
						pullRequests?: {
							nodes?: Array<{
								number?: number;
								commits?: {
									nodes?: Array<{
										commit?: {
											statusCheckRollup?: {
												contexts?: {
													nodes?: Array<{
														__typename?: string;
														status?: string;
														conclusion?: string | null;
														state?: string;
													}>;
												};
											} | null;
										};
									}>;
								};
								reviewThreads?: {
									nodes?: Array<{isResolved?: boolean}>;
								};
							}>;
						};
					};
				};
			};

			const pr = parsed.data?.repository?.pullRequests?.nodes?.[0];
			if (!pr) return empty;

			const contextNodes =
				pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ??
				[];
			const contexts: CheckContext[] = contextNodes.map(node => ({
				status: node.status,
				conclusion: node.conclusion ?? undefined,
				state: node.state,
			}));
			const pipeline = classifyPipeline(contexts);

			const threadNodes = pr.reviewThreads?.nodes ?? [];
			const unresolvedCommentCount = threadNodes.filter(
				t => t.isResolved === false,
			).length;

			return {
				pipeline,
				unresolvedCommentCount,
				prNumber: pr.number,
			};
		} catch (err) {
			log.warn(
				`Failed to fetch rail status for ${issueKey}`,
				sanitizeSubprocessError(err),
			);
			return empty;
		}
	}
}
