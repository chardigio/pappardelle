// GitHub VCS host provider — wraps gh CLI
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createLogger} from '../logger.ts';
import {classifyPipeline, type CheckContext} from '../rail-status.ts';
import {sanitizeSubprocessError} from '../sanitize-error.ts';
import type {PRInfo, RailStatus, VcsHostProvider} from './types.ts';

const log = createLogger('github-provider');
const execFileAsync = promisify(execFile);

/** Invokes `gh` with the given args and returns stdout. Injectable for tests. */
export type GhExecutor = (args: string[]) => Promise<string>;

/** Synchronous variant for code paths that block the UI on a single short call. */
export type SyncGhExecutor = (args: string[]) => string;

const defaultGhExecutor: GhExecutor = async args => {
	const {stdout} = await execFileAsync('gh', args, {
		encoding: 'utf-8',
		timeout: 15_000,
	});
	return stdout;
};

const defaultSyncGhExecutor: SyncGhExecutor = args =>
	execFileSync('gh', args, {encoding: 'utf-8', timeout: 10_000});

type PrNodeRaw = {
	number?: number;
	mergeable?: string;
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
};

function parsePrNode(pr: PrNodeRaw): RailStatus {
	const contextNodes =
		pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
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
	const hasConflict = pr.mergeable === 'CONFLICTING';
	return {pipeline, unresolvedCommentCount, prNumber: pr.number, hasConflict};
}

// Shared GraphQL fragment for the PR fields we need
const PR_FIELDS = `
	nodes {
		number
		mergeable
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
`;

export class GitHubProvider implements VcsHostProvider {
	readonly name = 'github';
	// undefined = not yet fetched; null = fetched but not in a GitHub repo
	private repoSlug: string | null | undefined = undefined;
	private readonly executor: GhExecutor;
	private readonly syncExecutor: SyncGhExecutor;

	/**
	 * @param executor - Optional async gh CLI wrapper; defaults to real execFile calls.
	 *   Pass a stub in tests to avoid subprocess calls.
	 * @param initialRepoSlug - Optional owner/repo slug. Pass a string in tests
	 *   to skip the `gh repo view` subprocess call; pass `null` to force the
	 *   "no slug" path (for testing resilience when not in a GitHub repo).
	 * @param syncExecutor - Optional sync gh CLI wrapper used by
	 *   `checkIssueHasPRWithCommits` (which blocks the UI on a single call).
	 */
	constructor(
		executor?: GhExecutor,
		initialRepoSlug?: string | null,
		syncExecutor?: SyncGhExecutor,
	) {
		this.executor = executor ?? defaultGhExecutor;
		this.syncExecutor = syncExecutor ?? defaultSyncGhExecutor;
		if (initialRepoSlug !== undefined) this.repoSlug = initialRepoSlug;
	}

	/**
	 * Get the owner/repo slug from the current git remote.
	 * Cached after first call. Returns null if not in a GitHub repo.
	 */
	private getRepoSlug(): string | null {
		if (this.repoSlug !== undefined) return this.repoSlug;
		try {
			const output = execFileSync(
				'gh',
				['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
				{encoding: 'utf-8', timeout: 10_000},
			);
			this.repoSlug = output.trim();
			return this.repoSlug;
		} catch {
			this.repoSlug = null;
			return null;
		}
	}

	checkIssueHasPRWithCommits(issueKey: string): PRInfo {
		try {
			// Discover PR by branch name (branch name matches issue key).
			// This approach is tracker-agnostic — no dependency on linctl or any
			// issue tracker. Works for Linear + GitHub and Jira + GitHub alike.
			//
			// `--state all` so a merged PR still resolves. The ordering `gh pr list`
			// uses isn't formally documented, but in practice it surfaces the
			// most-recently-updated PR first (inherited from GitHub's GraphQL
			// default), which means `--limit 1` returns the open PR when one
			// exists and falls back to the latest merged PR otherwise. The two
			// observable cases (open exists / only merged exists) are both
			// pinned in github-provider.test.ts.
			const prOutput = this.syncExecutor([
				'pr',
				'list',
				'--head',
				issueKey,
				'--state',
				'all',
				'--json',
				'number,url,changedFiles',
				'--limit',
				'1',
			]);
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
							${PR_FIELDS}
						}
					}
				}
			`;

			// Async exec — execFileSync would block the Ink event loop for the
			// entire duration of the gh call (~500ms-1s), and Promise.all over N
			// spaces would make initial pappardelle startup feel frozen.
			const stdout = await this.executor([
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
			]);

			const parsed = JSON.parse(stdout) as {
				data?: {
					repository?: {
						pullRequests?: {
							nodes?: PrNodeRaw[];
						};
					};
				};
			};

			const pr = parsed.data?.repository?.pullRequests?.nodes?.[0];
			if (!pr) return empty;

			return parsePrNode(pr);
		} catch (err) {
			log.warn(
				`Failed to fetch rail status for ${issueKey}`,
				sanitizeSubprocessError(err),
			);
			return empty;
		}
	}

	async getBulkRailStatus(
		issueKeys: string[],
	): Promise<Map<string, RailStatus>> {
		const result = new Map<string, RailStatus>();
		if (issueKeys.length === 0) return result;

		const slug = this.getRepoSlug();
		if (!slug) return result;

		const [owner, name] = slug.split('/');
		if (!owner || !name) return result;

		// Build one aliased pullRequests field per branch so a single GraphQL
		// request fetches all PR states. Alias names are pr0, pr1, … and we
		// keep issueKeys as the index-to-key mapping.
		const aliases = issueKeys
			.map(
				(key, i) =>
					`pr${i}: pullRequests(headRefName: ${JSON.stringify(key)}, first: 1, states: OPEN) {\n${PR_FIELDS}\n}`,
			)
			.join('\n');

		const query = `
			query($owner: String!, $name: String!) {
				repository(owner: $owner, name: $name) {
					${aliases}
				}
			}
		`;

		try {
			const stdout = await this.executor([
				'api',
				'graphql',
				'-F',
				`owner=${owner}`,
				'-F',
				`name=${name}`,
				'-f',
				`query=${query}`,
			]);

			const parsed = JSON.parse(stdout) as {
				data?: {
					repository?: Record<string, {nodes?: PrNodeRaw[]} | undefined>;
				};
				errors?: Array<{message: string}>;
			};

			if (parsed.errors?.length) {
				log.warn(
					`Partial GraphQL errors in bulk rail status: ${parsed.errors.map(e => e.message).join('; ')}`,
				);
			}

			for (let i = 0; i < issueKeys.length; i++) {
				const key = issueKeys[i]!;
				const prData = parsed.data?.repository?.[`pr${i}`];
				const pr = prData?.nodes?.[0];
				if (!pr) {
					result.set(key, {pipeline: null, unresolvedCommentCount: 0});
					continue;
				}

				result.set(key, parsePrNode(pr));
			}
		} catch (err) {
			log.warn(
				'Failed to fetch bulk rail status',
				sanitizeSubprocessError(err),
			);
			// Return empty Map — callers keep existing state on total failure
		}

		return result;
	}
}
