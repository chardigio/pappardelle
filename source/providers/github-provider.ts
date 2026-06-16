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

// Selection set for PR fields used inside `... on PullRequest { ... }`.
const PR_FIELDS_INNER = `
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
`;

// Pin to the most-recently-updated PR for a branch. PR lookups use GitHub's
// `search()` API with a `head:X` qualifier rather than
// `pullRequests(headRefName: X)`. Two reasons:
//   1. `headRefName:` is an exact match on branch name, so follow-up PRs on
//      derived branches (e.g. `X-FOLLOW-1` for issue X) are invisible. The
//      search qualifier `head:X` does tokenized prefix matching and catches
//      both the parent branch and any siblings.
//   2. `pullRequests` defaults to CREATED_AT ASC (oldest first); search's
//      `sort:updated-desc` puts the most recently active PR first, so the
//      `g` shortcut and rail status reflect what the user is actually
//      working on rather than a long-ago merged reuse of the same name.
const PR_SORT = 'sort:updated-desc';

function buildPRSearchQuery(
	slug: string,
	issueKey: string,
	openOnly: boolean,
): string {
	const base = `repo:${slug} head:${issueKey} is:pr`;
	return openOnly ? `${base} is:open ${PR_SORT}` : `${base} ${PR_SORT}`;
}

function isValidSlug(slug: string): boolean {
	const parts = slug.split('/');
	return parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
}

export class GitHubProvider implements VcsHostProvider {
	get name() {
		return 'github';
	}

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
		// Discover PR by branch name (branch name matches issue key, or a
		// prefix of it for follow-up branches). This approach is
		// tracker-agnostic — no dependency on linctl or any issue tracker.
		// Works for Linear + GitHub and Jira + GitHub alike.
		//
		// Uses GraphQL `search()` with a `head:X` qualifier rather than
		// `pullRequests(headRefName: X)` so follow-up branches like
		// `X-FOLLOW-1` resolve from the parent issue key X. No state filter
		// — merged PRs stay resolvable when no open PR exists. See PR_SORT
		// for ordering rationale.
		const slug = this.getRepoSlug();
		if (!slug || !isValidSlug(slug)) {
			return {hasPR: false, hasCommits: false};
		}

		try {
			const searchQuery = buildPRSearchQuery(slug, issueKey, false);
			const query = `
				query {
					search(query: ${JSON.stringify(searchQuery)}, type: ISSUE, first: 1) {
						nodes {
							... on PullRequest {
								number
								url
								changedFiles
							}
						}
					}
				}
			`;

			const stdout = this.syncExecutor([
				'api',
				'graphql',
				'-f',
				`query=${query}`,
			]);

			const parsed = JSON.parse(stdout) as {
				data?: {
					search?: {
						nodes?: Array<{
							number: number;
							url: string;
							changedFiles: number;
						}>;
					};
				};
			};

			const pr = parsed.data?.search?.nodes?.[0];
			if (!pr) {
				return {hasPR: false, hasCommits: false};
			}

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
		if (!slug || !isValidSlug(slug)) return empty;

		try {
			const searchQuery = buildPRSearchQuery(slug, issueKey, true);
			const query = `
				query {
					search(query: ${JSON.stringify(searchQuery)}, type: ISSUE, first: 1) {
						nodes {
							... on PullRequest {
								${PR_FIELDS_INNER}
							}
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
				'-f',
				`query=${query}`,
			]);

			const parsed = JSON.parse(stdout) as {
				data?: {
					search?: {
						nodes?: PrNodeRaw[];
					};
				};
			};

			const pr = parsed.data?.search?.nodes?.[0];
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
		if (!slug || !isValidSlug(slug)) return result;

		// Build one aliased search() field per branch so a single GraphQL
		// request fetches all PR states. Alias names are pr0, pr1, … and we
		// keep issueKeys as the index-to-key mapping.
		const aliases = issueKeys
			.map((key, i) => {
				const searchQuery = buildPRSearchQuery(slug, key, true);
				return `pr${i}: search(query: ${JSON.stringify(searchQuery)}, type: ISSUE, first: 1) {\n\tnodes {\n\t\t... on PullRequest {\n${PR_FIELDS_INNER}\n\t\t}\n\t}\n}`;
			})
			.join('\n');

		const query = `
			query {
				${aliases}
			}
		`;

		try {
			const stdout = await this.executor([
				'api',
				'graphql',
				'-f',
				`query=${query}`,
			]);

			const parsed = JSON.parse(stdout) as {
				data?: Record<string, {nodes?: PrNodeRaw[]} | undefined>;
				errors?: Array<{message: string}>;
			};

			if (parsed.errors?.length) {
				// Keep the headline short; route the joined error bodies through
				// the error parameter so they get sanitized + clipped on display
				// rather than rendered as a wall of text.
				const detail = parsed.errors.map(e => e.message).join('; ');
				log.warn(
					'Partial GraphQL errors in bulk rail status',
					new Error(detail),
				);
			}

			for (let i = 0; i < issueKeys.length; i++) {
				const key = issueKeys[i]!;
				const prData = parsed.data?.[`pr${i}`];
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
