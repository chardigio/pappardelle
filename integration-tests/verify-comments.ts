#!/usr/bin/env npx tsx
/**
 * Local verification of createComment on Linear and Jira providers.
 * Posts a test comment, verifies success, then notes it for manual cleanup.
 *
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-comments.ts`
 *
 * Env vars:
 *   LINEAR_ISSUE    — Linear issue to comment on (default: STA-683)
 *   JIRA_ISSUE      — Jira issue to comment on (optional, skipped if not set)
 *   JIRA_BASE_URL   — Jira base URL (required if JIRA_ISSUE is set)
 */

import {LinearProvider} from '../source/providers/linear-provider.ts';
import {JiraProvider} from '../source/providers/jira-provider.ts';

const LINEAR_ISSUE = process.env['LINEAR_ISSUE'] ?? 'STA-683';
const JIRA_ISSUE = process.env['JIRA_ISSUE'];
const JIRA_BASE_URL = process.env['JIRA_BASE_URL'];

const TIMESTAMP = new Date().toISOString();
const TEST_COMMENT = `\u{1f9ea} Integration test comment — posted at ${TIMESTAMP} by verify-comments.ts. Safe to delete.`;

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

async function main() {
	console.log('Comment Posting — Local Verification');
	console.log(`Timestamp: ${TIMESTAMP}`);

	// ── Linear ────────────────────────────────────────────────
	header(`Linear: createComment("${LINEAR_ISSUE}")`);
	info('comment', TEST_COMMENT);

	const linear = new LinearProvider();

	// Verify issue exists first
	const linearIssue = await linear.getIssue(LINEAR_ISSUE);
	if (!linearIssue) {
		fail(`Could not fetch ${LINEAR_ISSUE} — is linctl on PATH?`);
	} else {
		pass(`Issue exists: ${linearIssue.title}`);

		const success = await linear.createComment(LINEAR_ISSUE, TEST_COMMENT);
		if (success) {
			pass('Comment posted successfully');
			console.log(
				`  \u26a0\ufe0f  Clean up: delete the test comment on ${LINEAR_ISSUE}`,
			);
		} else {
			fail('createComment returned false');
		}
	}

	// ── Jira ──────────────────────────────────────────────────
	if (JIRA_ISSUE) {
		if (!JIRA_BASE_URL) {
			fail('JIRA_BASE_URL is required when JIRA_ISSUE is set');
		} else {
			header(`Jira: createComment("${JIRA_ISSUE}")`);
			info('comment', TEST_COMMENT);

			const jira = new JiraProvider(JIRA_BASE_URL);

			// Verify issue exists first
			const jiraIssue = await jira.getIssue(JIRA_ISSUE);
			if (!jiraIssue) {
				fail(`Could not fetch ${JIRA_ISSUE} — is acli on PATH?`);
			} else {
				pass(`Issue exists: ${jiraIssue.title}`);

				const success = await jira.createComment(JIRA_ISSUE, TEST_COMMENT);
				if (success) {
					pass('Comment posted successfully');
					console.log(
						`  \u26a0\ufe0f  Clean up: delete the test comment on ${JIRA_ISSUE}`,
					);
				} else {
					fail('createComment returned false');
				}
			}
		}
	} else {
		header('Jira: createComment (skipped)');
		pass('JIRA_ISSUE not set — skipping Jira comment test');
		console.log(
			'  To test: JIRA_ISSUE=KAN-8 JIRA_BASE_URL=https://... npx tsx integration-tests/verify-comments.ts',
		);
	}

	// ── Summary ───────────────────────────────────────────────
	header('Summary');
	if (failed) {
		fail('Some checks failed — see above');
		process.exit(1);
	} else {
		pass('All comment checks passed');
		console.log('\n  Remember to clean up test comments on the issues above.');
	}
}

main().catch(err => {
	console.error('Unhandled error:', err);
	process.exit(1);
});
