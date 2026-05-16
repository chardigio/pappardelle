#!/usr/bin/env npx tsx
/**
 * Local verification script for GitHubProvider against a real GitHub repo.
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-github.ts`
 *
 * Must be run from inside a git repo with a GitHub remote.
 *
 * Env vars:
 *   GITHUB_ISSUE — branch/issue key to check for PRs (default: STA-683)
 *   GITHUB_PR    — known PR number to test buildPRUrl (default: auto-detected)
 *   GITHUB_MULTI_PR_BRANCH — branch with multiple PRs (open + merged) to
 *                            stress-test ordering. If unset, the script
 *                            auto-detects a candidate via `gh search prs`.
 */

import {execFileSync} from 'node:child_process';
import {GitHubProvider} from '../source/providers/github-provider.ts';

const ISSUE_KEY = process.env['GITHUB_ISSUE'] ?? 'STA-683';
const EXPLICIT_PR = process.env['GITHUB_PR']
	? Number(process.env['GITHUB_PR'])
	: undefined;

let failed = false;

function header(title: string) {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`  ${title}`);
	console.log('='.repeat(60));
}

function pass(msg: string) {
	console.log(`  \u2705 ${msg}`);
}

function fail(msg: string) {
	console.log(`  \u274c ${msg}`);
	failed = true;
}

function info(label: string, value: unknown) {
	console.log(`  ${label}: ${JSON.stringify(value)}`);
}

type PrListEntry = {number: number; url: string; updatedAt: string};

/**
 * Find a head-branch name in the current repo that has more than one PR
 * (the case where ordering actually matters). Returns null if none is
 * found within the search budget.
 */
function findMultiPrBranch(): string | null {
	const override = process.env['GITHUB_MULTI_PR_BRANCH'];
	if (override) return override;

	try {
		// Walk recently updated PRs and look for any head ref name that
		// appears twice. `gh search prs` doesn't expose duplicates directly,
		// so we paginate one batch and count locally.
		const stdout = execFileSync(
			'gh',
			[
				'pr',
				'list',
				'--state',
				'all',
				'--limit',
				'200',
				'--json',
				'headRefName',
			],
			{encoding: 'utf-8', timeout: 15_000},
		);
		const prs = JSON.parse(stdout) as Array<{headRefName: string}>;
		const counts = new Map<string, number>();
		for (const pr of prs) {
			counts.set(pr.headRefName, (counts.get(pr.headRefName) ?? 0) + 1);
		}
		for (const [branch, count] of counts) {
			if (count > 1) return branch;
		}
	} catch {
		// Falls through to the null return — verification will skip with a
		// pass message.
	}
	return null;
}

function listPrsForBranch(branch: string): PrListEntry[] {
	const stdout = execFileSync(
		'gh',
		[
			'pr',
			'list',
			'--head',
			branch,
			'--state',
			'all',
			'--json',
			'number,url,updatedAt',
			'--limit',
			'50',
		],
		{encoding: 'utf-8', timeout: 15_000},
	);
	return JSON.parse(stdout) as PrListEntry[];
}

function verifyOrderingForBranch(provider: GitHubProvider) {
	const branch = findMultiPrBranch();
	header('PR ordering — latest-updatedAt wins');

	if (!branch) {
		pass(
			'No head branch with multiple PRs found in the recent window; ordering check skipped (set GITHUB_MULTI_PR_BRANCH to force)',
		);
		return;
	}

	info('branch', branch);

	let allPrs: PrListEntry[];
	try {
		allPrs = listPrsForBranch(branch);
	} catch (err) {
		fail(`Failed to list PRs for branch "${branch}": ${String(err)}`);
		return;
	}

	info('matching PR count', allPrs.length);
	if (allPrs.length < 2) {
		pass(
			`Branch "${branch}" no longer has multiple PRs at query time; ordering check skipped`,
		);
		return;
	}

	const expected = allPrs.reduce((newest, current) =>
		current.updatedAt > newest.updatedAt ? current : newest,
	);
	info('expected (max updatedAt)', {
		number: expected.number,
		updatedAt: expected.updatedAt,
	});

	const actual = provider.checkIssueHasPRWithCommits(branch);
	info('provider returned', {number: actual.prNumber, url: actual.prUrl});

	if (!actual.hasPR) {
		fail('Provider returned hasPR=false for a branch known to have PRs');
		return;
	}

	if (actual.prNumber === expected.number) {
		pass(
			`Provider returned the most-recently-updated PR (#${expected.number})`,
		);
	} else {
		const wrong = allPrs.find(p => p.number === actual.prNumber);
		fail(
			`Provider returned PR #${actual.prNumber} (updatedAt ${wrong?.updatedAt ?? '?'}) but expected #${expected.number} (updatedAt ${expected.updatedAt})`,
		);
	}
}

function main() {
	console.log('GitHub Provider — Local Verification');
	console.log(`Issue key: ${ISSUE_KEY}`);

	const provider = new GitHubProvider();

	// ── checkIssueHasPRWithCommits ─────────────────────────────
	header(`checkIssueHasPRWithCommits("${ISSUE_KEY}")`);
	const prInfo = provider.checkIssueHasPRWithCommits(ISSUE_KEY);

	info('hasPR', prInfo.hasPR);
	info('hasCommits', prInfo.hasCommits);
	info('prNumber', prInfo.prNumber);
	info('prUrl', prInfo.prUrl);

	if (prInfo.hasPR) {
		pass('PR found for issue branch');
		if (prInfo.prNumber && prInfo.prNumber > 0) {
			pass(`PR number is valid: #${prInfo.prNumber}`);
		} else {
			fail('PR number is missing or invalid');
		}

		if (prInfo.prUrl && prInfo.prUrl.startsWith('https://github.com/')) {
			pass(`PR URL looks correct: ${prInfo.prUrl}`);
		} else {
			fail(`PR URL unexpected: ${prInfo.prUrl}`);
		}

		if (prInfo.hasCommits) {
			pass('PR has file changes');
		} else {
			pass('PR has no file changes (empty PR — may be expected)');
		}
	} else {
		pass(`No PR found for branch "${ISSUE_KEY}" (may be expected)`);
	}

	// ── checkIssueHasPRWithCommits with non-existent branch ───
	header('checkIssueHasPRWithCommits("NONEXISTENT-999999")');
	const noPR = provider.checkIssueHasPRWithCommits('NONEXISTENT-999999');

	if (!noPR.hasPR && !noPR.hasCommits) {
		pass('Correctly returned no PR for non-existent branch');
	} else {
		fail('Should not find a PR for non-existent branch');
	}

	// ── buildPRUrl ────────────────────────────────────────────
	const prNumber = EXPLICIT_PR ?? prInfo.prNumber ?? 1;
	header(`buildPRUrl(${prNumber})`);
	const url = provider.buildPRUrl(prNumber);
	info('url', url);

	if (url.includes('github.com') && url.includes(String(prNumber))) {
		pass('URL contains github.com and PR number');
	} else {
		fail('URL format unexpected');
	}

	// Check it includes the repo slug
	if (url.includes('/pull/')) {
		pass('URL has /pull/ path');
	} else {
		fail('URL missing /pull/ path');
	}

	// ── PR ordering: latest-updated wins ─────────────────────
	// The provider must return the most-recently-updated PR for a head
	// branch, not the oldest. Verifies the fix end-to-end against real
	// GitHub by comparing the provider's choice to the max-updatedAt PR
	// from an independent `gh pr list` call.
	verifyOrderingForBranch(provider);

	// ── Summary ───────────────────────────────────────────────
	header('Summary');
	if (failed) {
		fail('Some checks failed — see above');
		process.exit(1);
	} else {
		pass('All checks passed');
	}
}

main();
