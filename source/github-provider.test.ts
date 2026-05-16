import test from 'ava';
import {clearRecentErrors, getRecentErrors} from './logger.ts';
import {
	GitHubProvider,
	type GhExecutor,
	type SyncGhExecutor,
} from './providers/github-provider.ts';

// ============================================================================
// Helpers
// ============================================================================

function makeGhResponse(
	aliases: Record<
		string,
		{
			number?: number;
			mergeable?: string;
			checkContexts?: Array<{
				__typename: string;
				status?: string;
				conclusion?: string | null;
				state?: string;
			}>;
			unresolvedThreads?: number;
		} | null
	>,
): string {
	const nodes: Record<string, unknown> = {};
	for (const [alias, data] of Object.entries(aliases)) {
		if (!data) {
			nodes[alias] = {nodes: []};
			continue;
		}

		const contextNodes = (data.checkContexts ?? []).map(ctx => {
			if (ctx.__typename === 'CheckRun') {
				return {
					__typename: 'CheckRun',
					status: ctx.status,
					conclusion: ctx.conclusion,
				};
			}

			return {__typename: 'StatusContext', state: ctx.state};
		});

		const threadNodes = Array.from(
			{length: data.unresolvedThreads ?? 0},
			() => ({isResolved: false}),
		);

		nodes[alias] = {
			nodes: [
				{
					number: data.number ?? 1,
					mergeable: data.mergeable ?? 'MERGEABLE',
					commits: {
						nodes: [
							{
								commit: {
									statusCheckRollup:
										contextNodes.length > 0
											? {contexts: {nodes: contextNodes}}
											: null,
								},
							},
						],
					},
					reviewThreads: {nodes: threadNodes},
				},
			],
		};
	}

	return JSON.stringify({data: {repository: nodes}});
}

// ============================================================================
// getBulkRailStatus
// ============================================================================

test('getBulkRailStatus: empty issueKeys returns empty Map', async t => {
	const exec: GhExecutor = async () => {
		t.fail('executor should not be called for empty input');
		return '';
	};
	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus([]);
	t.is(result.size, 0);
});

test('getBulkRailStatus: no repo slug returns empty Map without calling executor', async t => {
	let called = false;
	const exec: GhExecutor = async () => {
		called = true;
		return '';
	};
	// null forces the "no slug" path — simulates running outside a GitHub repo
	const provider = new GitHubProvider(exec, null);
	const result = await provider.getBulkRailStatus(['STA-123']);
	t.is(result.size, 0);
	t.false(called);
});

test('getBulkRailStatus: single issue with passing checks', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: {
				number: 42,
				checkContexts: [
					{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS'},
				],
			},
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-123']);

	t.is(result.size, 1);
	const status = result.get('STA-123')!;
	t.is(status.pipeline, 'passing');
	t.is(status.unresolvedCommentCount, 0);
	t.is(status.prNumber, 42);
	t.false(status.hasConflict);
});

test('getBulkRailStatus: single issue with failing checks', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: {
				checkContexts: [
					{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE'},
					{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS'},
				],
			},
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-555']);

	const status = result.get('STA-555')!;
	t.is(status.pipeline, 'failing');
});

test('getBulkRailStatus: single issue with in-progress checks', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: {
				checkContexts: [
					{__typename: 'CheckRun', status: 'IN_PROGRESS'},
					{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS'},
				],
			},
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-100']);

	t.is(result.get('STA-100')!.pipeline, 'progressing_clean');
});

test('getBulkRailStatus: conflict detected', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: {mergeable: 'CONFLICTING'},
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-200']);

	t.true(result.get('STA-200')!.hasConflict);
});

test('getBulkRailStatus: unresolved comments counted', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: {
				unresolvedThreads: 3,
				checkContexts: [
					{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS'},
				],
			},
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-300']);

	t.is(result.get('STA-300')!.unresolvedCommentCount, 3);
});

test('getBulkRailStatus: branch with no open PR returns pipeline null', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: null,
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-404']);

	const status = result.get('STA-404')!;
	t.is(status.pipeline, null);
	t.is(status.unresolvedCommentCount, 0);
});

test('getBulkRailStatus: multiple issues, results mapped to correct keys', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: {
				number: 10,
				checkContexts: [
					{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS'},
				],
			},
			pr1: {
				number: 20,
				checkContexts: [
					{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE'},
				],
			},
			pr2: null,
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-1', 'STA-2', 'STA-3']);

	t.is(result.size, 3);
	t.is(result.get('STA-1')!.pipeline, 'passing');
	t.is(result.get('STA-1')!.prNumber, 10);
	t.is(result.get('STA-2')!.pipeline, 'failing');
	t.is(result.get('STA-2')!.prNumber, 20);
	t.is(result.get('STA-3')!.pipeline, null);
});

test('getBulkRailStatus: passes all branch names in single query', async t => {
	let capturedArgs: string[] = [];
	const exec: GhExecutor = async (args: string[]) => {
		capturedArgs = args;
		return makeGhResponse({pr0: null, pr1: null});
	};

	const provider = new GitHubProvider(exec, 'myorg/myrepo');
	await provider.getBulkRailStatus(['branch-a', 'branch-b']);

	// Should have made exactly one call
	t.is(capturedArgs[0], 'api');
	t.is(capturedArgs[1], 'graphql');

	// Query should contain both branch names as aliases
	const queryArg = capturedArgs.find(a => a.startsWith('query=')) ?? '';
	t.true(queryArg.includes('pr0:'));
	t.true(queryArg.includes('pr1:'));
	t.true(queryArg.includes('"branch-a"'));
	t.true(queryArg.includes('"branch-b"'));
});

test('getBulkRailStatus: total API failure returns empty Map', async t => {
	const exec: GhExecutor = async () => {
		throw new Error('gh: API rate limit exceeded');
	};

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-999']);

	// Returns empty Map — caller keeps existing state
	t.is(result.size, 0);
});

test.serial(
	'getBulkRailStatus: partial GraphQL errors warn and still return available data',
	async t => {
		clearRecentErrors();

		const exec: GhExecutor = async () =>
			JSON.stringify({
				data: {
					repository: {
						pr0: {
							nodes: [
								{
									number: 42,
									mergeable: 'MERGEABLE',
									commits: {
										nodes: [
											{
												commit: {
													statusCheckRollup: {
														contexts: {
															nodes: [
																{
																	__typename: 'CheckRun',
																	status: 'COMPLETED',
																	conclusion: 'SUCCESS',
																},
															],
														},
													},
												},
											},
										],
									},
									reviewThreads: {nodes: []},
								},
							],
						},
						pr1: {nodes: []}, // aliased field empty due to partial error
					},
				},
				errors: [{message: 'Field-level permission denied for STA-2'}],
			});

		const provider = new GitHubProvider(exec, 'owner/repo');
		const result = await provider.getBulkRailStatus(['STA-1', 'STA-2']);

		// Partial data is still used
		t.is(result.size, 2);
		t.is(result.get('STA-1')!.pipeline, 'passing');
		t.is(result.get('STA-1')!.prNumber, 42);
		t.is(result.get('STA-2')!.pipeline, null);

		// Warning was emitted for the errors field — the headline is a short,
		// stable string and the dynamic error bodies live in `entry.error` so
		// the TUI clip path (`clipLogEntryForDisplay`) bounds the rendered size
		// even when many aliases fail at once.
		const warnings = getRecentErrors().filter(
			e =>
				e.level === 'warn' &&
				e.message === 'Partial GraphQL errors in bulk rail status',
		);
		t.is(warnings.length, 1);
		t.true(warnings[0]!.error!.includes('Field-level permission denied'));
	},
);

test('getBulkRailStatus: StatusContext nodes supported', async t => {
	const exec: GhExecutor = async () =>
		makeGhResponse({
			pr0: {
				checkContexts: [
					{__typename: 'StatusContext', state: 'SUCCESS'},
					{__typename: 'StatusContext', state: 'PENDING'},
				],
			},
		});

	const provider = new GitHubProvider(exec, 'owner/repo');
	const result = await provider.getBulkRailStatus(['STA-77']);

	t.is(result.get('STA-77')!.pipeline, 'progressing_clean');
});

// ============================================================================
// checkIssueHasPRWithCommits
// ============================================================================

// Build the GraphQL response shape returned by checkIssueHasPRWithCommits' query.
function makePrListResponse(
	prs: Array<{number: number; url: string; changedFiles: number}>,
): string {
	return JSON.stringify({
		data: {repository: {pullRequests: {nodes: prs}}},
	});
}

test('checkIssueHasPRWithCommits: open PR found returns hasPR true with url and number', t => {
	let capturedArgs: string[] = [];
	const syncExec: SyncGhExecutor = (args: string[]) => {
		capturedArgs = args;
		return makePrListResponse([
			{
				number: 42,
				url: 'https://github.com/owner/repo/pull/42',
				changedFiles: 5,
			},
		]);
	};

	const provider = new GitHubProvider(undefined, 'owner/repo', syncExec);
	const result = provider.checkIssueHasPRWithCommits('STA-100');

	t.true(result.hasPR);
	t.true(result.hasCommits);
	t.is(result.prNumber, 42);
	t.is(result.prUrl, 'https://github.com/owner/repo/pull/42');

	// Pin the gh invocation: GraphQL query with the branch name forwarded
	// as a string variable.
	t.is(capturedArgs[0], 'api');
	t.is(capturedArgs[1], 'graphql');
	t.true(capturedArgs.includes('branch=STA-100'));
});

test('checkIssueHasPRWithCommits: merged PR is found', t => {
	// Simulate a branch whose only PR has already been merged. The GraphQL
	// query intentionally omits a `states:` filter so merged PRs still
	// surface; this test pins that behavior.
	const syncExec: SyncGhExecutor = () =>
		makePrListResponse([
			{
				number: 1092,
				url: 'https://github.com/owner/repo/pull/1092',
				changedFiles: 14,
			},
		]);

	const provider = new GitHubProvider(undefined, 'owner/repo', syncExec);
	const result = provider.checkIssueHasPRWithCommits('STA-1078');

	t.true(result.hasPR);
	t.true(result.hasCommits);
	t.is(result.prNumber, 1092);
	t.is(result.prUrl, 'https://github.com/owner/repo/pull/1092');
});

test('checkIssueHasPRWithCommits: no PR found returns hasPR false', t => {
	const syncExec: SyncGhExecutor = () => makePrListResponse([]);

	const provider = new GitHubProvider(undefined, 'owner/repo', syncExec);
	const result = provider.checkIssueHasPRWithCommits('STA-404');

	t.false(result.hasPR);
	t.false(result.hasCommits);
	t.is(result.prNumber, undefined);
	t.is(result.prUrl, undefined);
});

test('checkIssueHasPRWithCommits: PR with no changed files returns hasCommits false', t => {
	const syncExec: SyncGhExecutor = () =>
		makePrListResponse([
			{
				number: 7,
				url: 'https://github.com/owner/repo/pull/7',
				changedFiles: 0,
			},
		]);

	const provider = new GitHubProvider(undefined, 'owner/repo', syncExec);
	const result = provider.checkIssueHasPRWithCommits('STA-7');

	t.true(result.hasPR);
	t.false(result.hasCommits);
});

test('checkIssueHasPRWithCommits: executor throwing returns hasPR false', t => {
	const syncExec: SyncGhExecutor = () => {
		throw new Error('gh: not authenticated');
	};

	const provider = new GitHubProvider(undefined, 'owner/repo', syncExec);
	const result = provider.checkIssueHasPRWithCommits('STA-500');

	t.false(result.hasPR);
	t.false(result.hasCommits);
});

test('checkIssueHasPRWithCommits: no repo slug returns hasPR false without calling executor', t => {
	let called = false;
	const syncExec: SyncGhExecutor = () => {
		called = true;
		return '';
	};
	// null forces the "no slug" path — simulates running outside a GitHub repo
	const provider = new GitHubProvider(undefined, null, syncExec);
	const result = provider.checkIssueHasPRWithCommits('STA-100');

	t.false(result.hasPR);
	t.false(result.hasCommits);
	t.false(called);
});

test('checkIssueHasPRWithCommits: query orders pull requests by UPDATED_AT DESC', t => {
	// When a branch matches multiple PRs (e.g. a reused branch name where the
	// first PR was merged long ago and a new PR was just opened), the `g`
	// shortcut would jump to the oldest PR. GitHub's GraphQL `pullRequests`
	// field defaults to CREATED_AT ASC, so without an explicit `orderBy` we
	// surface the oldest match. The query must request UPDATED_AT DESC so we
	// open the PR the user actually worked on most recently.
	let capturedArgs: string[] = [];
	const syncExec: SyncGhExecutor = (args: string[]) => {
		capturedArgs = args;
		return makePrListResponse([
			{
				number: 999,
				url: 'https://github.com/owner/repo/pull/999',
				changedFiles: 3,
			},
		]);
	};

	const provider = new GitHubProvider(undefined, 'owner/repo', syncExec);
	provider.checkIssueHasPRWithCommits('STA-reused-branch');

	const queryArg = capturedArgs.find(a => a.startsWith('query=')) ?? '';
	t.true(
		queryArg.includes('orderBy'),
		`expected query to include orderBy clause: ${queryArg}`,
	);
	t.true(
		queryArg.includes('UPDATED_AT'),
		`expected orderBy field UPDATED_AT: ${queryArg}`,
	);
	t.true(
		queryArg.includes('DESC'),
		`expected orderBy direction DESC: ${queryArg}`,
	);
});

// ============================================================================
// getRailStatus / getBulkRailStatus — ordering
// ============================================================================

test('getRailStatus: query orders pull requests by UPDATED_AT DESC', async t => {
	// Rail status (pipeline, unresolved comments, merge conflict) must reflect
	// the most recently updated PR for a branch, not the oldest one (which is
	// often a long-ago merged reuse of the same branch name).
	let capturedArgs: string[] = [];
	const exec: GhExecutor = async (args: string[]) => {
		capturedArgs = args;
		return makeGhResponse({pr0: null});
	};

	const provider = new GitHubProvider(exec, 'owner/repo');
	await provider.getRailStatus('STA-branch-reuse');

	const queryArg = capturedArgs.find(a => a.startsWith('query=')) ?? '';
	t.true(queryArg.includes('orderBy'));
	t.true(queryArg.includes('UPDATED_AT'));
	t.true(queryArg.includes('DESC'));
});

test('getBulkRailStatus: each aliased query orders pull requests by UPDATED_AT DESC', async t => {
	let capturedArgs: string[] = [];
	const exec: GhExecutor = async (args: string[]) => {
		capturedArgs = args;
		return makeGhResponse({pr0: null, pr1: null});
	};

	const provider = new GitHubProvider(exec, 'owner/repo');
	await provider.getBulkRailStatus(['STA-1', 'STA-2']);

	const queryArg = capturedArgs.find(a => a.startsWith('query=')) ?? '';
	// Every aliased pullRequests(...) call must include the orderBy clause;
	// matching the substring twice guarantees we didn't only sort the first
	// alias.
	const orderByOccurrences = queryArg.split('orderBy').length - 1;
	t.is(
		orderByOccurrences,
		2,
		`expected orderBy in both aliased queries, found ${orderByOccurrences}: ${queryArg}`,
	);
	t.true(queryArg.includes('UPDATED_AT'));
	t.true(queryArg.includes('DESC'));
});
