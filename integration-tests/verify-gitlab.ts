#!/usr/bin/env npx tsx
/**
 * Local verification script for GitLabProvider against a real GitLab instance.
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-gitlab.ts`
 *
 * Must be run from inside a git repo with a GitLab remote, or specify GITLAB_HOST.
 *
 * Env vars:
 *   GITLAB_HOST    — self-hosted GitLab host (default: gitlab.com)
 *   GITLAB_ISSUE   — branch/issue key to check for MRs (required)
 *   GITLAB_MR      — known MR number to test buildPRUrl (default: auto-detected)
 */

import {GitLabProvider} from '../source/providers/gitlab-provider.ts';

const HOST = process.env['GITLAB_HOST'];
const ISSUE_KEY = process.env['GITLAB_ISSUE'];
const EXPLICIT_MR = process.env['GITLAB_MR']
	? Number(process.env['GITLAB_MR'])
	: undefined;

if (!ISSUE_KEY) {
	console.error(
		'\u274c GITLAB_ISSUE is required. Example:\n  GITLAB_ISSUE=PROJ-123 npx tsx integration-tests/verify-gitlab.ts',
	);
	process.exit(1);
}

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
	console.log('GitLab Provider — Local Verification');
	console.log(`Host: ${HOST ?? 'gitlab.com'}`);
	console.log(`Issue key: ${ISSUE_KEY}`);

	const provider = new GitLabProvider(HOST);

	// ── checkIssueHasPRWithCommits ─────────────────────────────
	header(`checkIssueHasPRWithCommits("${ISSUE_KEY}")`);
	const mrInfo = provider.checkIssueHasPRWithCommits(ISSUE_KEY);

	info('hasPR', mrInfo.hasPR);
	info('hasCommits', mrInfo.hasCommits);
	info('prNumber (MR iid)', mrInfo.prNumber);
	info('prUrl', mrInfo.prUrl);

	if (mrInfo.hasPR) {
		pass('MR found for issue branch');
		if (mrInfo.prNumber && mrInfo.prNumber > 0) {
			pass(`MR iid is valid: !${mrInfo.prNumber}`);
		} else {
			fail('MR iid is missing or invalid');
		}

		if (mrInfo.prUrl) {
			pass(`MR URL: ${mrInfo.prUrl}`);
		} else {
			fail('MR URL is missing');
		}

		if (mrInfo.hasCommits) {
			pass('MR has file changes');
		} else {
			pass('MR has no file changes (empty MR — may be expected)');
		}
	} else {
		pass(`No MR found for branch "${ISSUE_KEY}" (may be expected)`);
	}

	// ── checkIssueHasPRWithCommits with non-existent branch ───
	header('checkIssueHasPRWithCommits("NONEXISTENT-999999")');
	const noMR = provider.checkIssueHasPRWithCommits('NONEXISTENT-999999');

	if (!noMR.hasPR && !noMR.hasCommits) {
		pass('Correctly returned no MR for non-existent branch');
	} else {
		fail('Should not find an MR for non-existent branch');
	}

	// ── buildPRUrl ────────────────────────────────────────────
	const mrNumber = EXPLICIT_MR ?? mrInfo.prNumber ?? 1;
	header(`buildPRUrl(${mrNumber})`);
	const url = provider.buildPRUrl(mrNumber);
	info('url', url);

	const expectedHost = HOST ?? 'gitlab.com';
	if (url.includes(expectedHost) && url.includes('merge_requests')) {
		pass('URL contains host and merge_requests path');
	} else {
		fail(`URL format unexpected — expected ${expectedHost} and merge_requests`);
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
