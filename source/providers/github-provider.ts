// GitHub VCS host provider — wraps gh CLI
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createLogger} from '../logger.ts';
import {classifyPipeline, type CheckContext} from '../rail-status.ts';
import {sanitizeSubprocessError} from '../sanitize-error.ts';
import type {PRInfo, RailStatus, VcsHostProvider} from './types.ts';
import {aggregateRailStatus} from './aggregate-rail-status.ts';
import {
	discoverWorkspaceRepositories,
	type RepositoryDiscovery,
	type WorkspaceRepository,
} from './workspace-repositories.ts';

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
	private readonly discover: RepositoryDiscovery;

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
		discover: RepositoryDiscovery = discoverWorkspaceRepositories,
	) {
		this.discover = discover;
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
		workspacePaths?: ReadonlyMap<string, string>,
	): Promise<Map<string, RailStatus>> {
		if (workspacePaths?.size) {
			const discovered = await this.getWorkspaceRailStatus(
				issueKeys.filter(key => workspacePaths.has(key)),
				workspacePaths,
			);
			const fallback = await this.getBulkRailStatus(
				issueKeys.filter(key => !workspacePaths.has(key)),
			);
			return new Map([...discovered, ...fallback]);
		}
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

	private async getWorkspaceRailStatus(
		issueKeys: string[],
		workspacePaths: ReadonlyMap<string, string>,
	): Promise<Map<string, RailStatus>> {
		const host = process.env['GH_HOST'] ?? 'github.com';
		const workspaces = new Map<string, string[]>();
		const repositories = new Map<string, WorkspaceRepository>();
		for (const issueKey of new Set(issueKeys)) {
			try {
				const discovered = await this.discover(
					workspacePaths.get(issueKey)!,
					host,
				);
				const keys = new Set<string>();
				for (const repository of discovered) {
					if (!isValidSlug(repository.project))
						throw new Error('Invalid GitHub repository slug');
					const key = JSON.stringify([repository.project, repository.branch]);
					keys.add(key);
					repositories.set(key, repository);
				}
				workspaces.set(issueKey, [...keys]);
			} catch (err) {
				log.warn(
					'Failed to discover GitHub workspace repositories',
					sanitizeSubprocessError(err),
				);
			}
		}
		const statuses = new Map<string, RailStatus>();
		const requests = [...repositories];
		if (requests.length > 0) {
			try {
				// The head ref finds PRs targeting upstream even when origin is a fork.
				const fields = requests.map(([, repo], i) => {
					const [owner, name] = repo.project.split('/');
					return `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
						ref(qualifiedName: ${JSON.stringify(`refs/heads/${repo.branch}`)}) {
							associatedPullRequests(states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}, first: 1) {
								nodes { ${PR_FIELDS_INNER} }
							}
						}
					}`;
				});
				const stdout = await this.executor([
					'api',
					'graphql',
					'--hostname',
					host,
					'-f',
					`query={${fields.join('\n')}}`,
				]);
				const parsed = JSON.parse(stdout) as {
					data?: Record<
						string,
						{
							ref?: {associatedPullRequests?: {nodes?: PrNodeRaw[]}} | null;
						} | null
					>;
					errors?: Array<{message: string; path?: Array<string | number>}>;
				};
				if (parsed.errors?.length)
					log.warn(
						'Partial GraphQL errors in workspace rail status',
						new Error(parsed.errors.map(error => error.message).join('; ')),
					);
				for (const [i, [key]] of requests.entries()) {
					const alias = `pr${i}`;
					if (
						parsed.errors?.some(
							error => !error.path?.length || error.path[0] === alias,
						)
					)
						continue;
					const ref = parsed.data?.[alias]?.ref;
					const nodes = ref === null ? [] : ref?.associatedPullRequests?.nodes;
					if (!Array.isArray(nodes)) continue;
					if (nodes.length === 0) {
						statuses.set(key, {pipeline: null, unresolvedCommentCount: 0});
					} else if (Number.isInteger(nodes[0]?.number)) {
						statuses.set(key, parsePrNode(nodes[0]!));
					}
				}
			} catch (err) {
				log.warn(
					'Failed to fetch GitHub workspace rail status',
					sanitizeSubprocessError(err),
				);
			}
		}
		const result = new Map<string, RailStatus>();
		for (const [issueKey, keys] of workspaces) {
			// Do not replace a workspace with an incomplete view of its repositories.
			if (keys.some(key => !statuses.has(key))) continue;
			result.set(
				issueKey,
				aggregateRailStatus(keys.map(key => statuses.get(key)!)),
			);
		}
		return result;
	}
}
