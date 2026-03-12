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
 */

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
