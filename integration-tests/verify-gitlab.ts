#!/usr/bin/env npx tsx
/**
 * Local verification script for GitLabProvider against a real GitLab instance.
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-gitlab.ts`
 *
 * Must be run from inside a git repo with a GitLab remote.
 * Rail status is compared with REST data for an existing open MR.
 *
 * Env vars:
 *   GITLAB_HOST    — self-hosted GitLab host (default: gitlab.com)
 *   GITLAB_ISSUE   — exact source branch of an open MR (required)
 *   GITLAB_MR      — known MR number to test buildPRUrl (default: auto-detected)
 */

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {GitLabProvider} from '../source/providers/gitlab-provider.ts';
import type {RailStatus} from '../source/providers/types.ts';

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

async function verifyRail(
	provider: GitLabProvider,
	issueKey: string,
	mrNumber: number,
) {
	const api = (endpoint: string) =>
		JSON.parse(
			execFileSync(
				'glab',
				['api', endpoint, ...(HOST ? ['--hostname', HOST] : [])],
				{encoding: 'utf-8', timeout: 15_000},
			),
		);
	const mr = api(`projects/:id/merge_requests/${mrNumber}`) as {
		iid: number;
		state: string;
		source_branch: string;
		detailed_merge_status: string;
		head_pipeline: {status: string} | null;
	};
	assert.equal(mr.state, 'opened', 'Rail verification requires an open MR');
	assert.equal(mr.source_branch, issueKey);
	let unresolved = 0;
	for (let page = 1; ; page++) {
		const discussions = api(
			`projects/:id/merge_requests/${mrNumber}/discussions?per_page=100&page=${page}`,
		) as Array<{
			notes: Array<{resolvable: boolean; resolved: boolean}>;
		}>;
		unresolved += discussions.filter(thread =>
			thread.notes.some(note => note.resolvable && !note.resolved),
		).length;
		if (discussions.length < 100) break;
	}
	const statuses: Record<string, RailStatus['pipeline']> = {
		success: 'passing',
		skipped: 'passing',
		failed: 'failing',
		canceled: 'failing',
	};
	const expected: RailStatus = {
		pipeline: mr.head_pipeline
			? (statuses[mr.head_pipeline.status] ?? 'progressing_clean')
			: null,
		prNumber: mr.iid,
		hasConflict: mr.detailed_merge_status === 'conflict',
		unresolvedCommentCount: unresolved,
	};
	const missing = 'pappardelle-verification-nonexistent-999999';
	const bulk = await provider.getBulkRailStatus([issueKey, missing]);
	assert.deepEqual(
		bulk.get(issueKey),
		expected,
		'Bulk rail must match REST data',
	);
	assert.deepEqual(bulk.get(missing), {
		pipeline: null,
		unresolvedCommentCount: 0,
	});
	assert.deepEqual(
		await provider.getRailStatus(issueKey),
		expected,
		'Single rail must match REST data',
	);
	info('rail status (verified against REST)', expected);
	pass(
		'Single and bulk rail status match REST; missing branch has empty status',
	);
}

async function main() {
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

	header('Rail status');
	await verifyRail(provider, ISSUE_KEY!, mrNumber);

	// ── Summary ───────────────────────────────────────────────
	header('Summary');
	if (failed) {
		fail('Some checks failed — see above');
		process.exit(1);
	} else {
		pass('All checks passed');
	}
}

try {
	await main();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
