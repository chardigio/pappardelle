#!/usr/bin/env npx tsx
/**
 * End-to-end verification of the watchlist pipeline against real providers.
 * Tests: config loading → provider fetch → label filtering → workspace decision
 *
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-watchlist.ts`
 *
 * Must be run from inside a repo with a .pappardelle.yml that has issue_watchlist configured.
 *
 * Env vars:
 *   EXISTING_SPACES — comma-separated list of existing space names to simulate
 *                     (default: empty — treats all issues as new)
 */

import {
	loadConfig,
	getIssueWatchlist,
	type IssueWatchlistConfig,
} from '../source/config.ts';
import {LinearProvider} from '../source/providers/linear-provider.ts';
import {JiraProvider} from '../source/providers/jira-provider.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
} from '../source/providers/types.ts';
import {getNewWatchlistIssues, filterByLabels} from '../source/watchlist.ts';

const EXISTING_SPACES = process.env['EXISTING_SPACES']
	? process.env['EXISTING_SPACES'].split(',').map(s => s.trim())
	: [];

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

function issueRow(issue: TrackerIssue) {
	const labelSummary =
		issue.labels === undefined ? '(no labels)' : `[${issue.labels.join(', ')}]`;
	console.log(
		`    ${issue.identifier} — ${issue.title} (${issue.state.name}) ${labelSummary}`,
	);
}

async function main() {
	console.log('Watchlist Pipeline — End-to-End Verification');

	// ── Step 1: Load config ───────────────────────────────────
	header('Step 1: Load config + get watchlist');
	let watchlist: IssueWatchlistConfig | undefined;
	try {
		const config = loadConfig();
		pass('Config loaded successfully');
		watchlist = getIssueWatchlist(config);
	} catch (err) {
		fail(`Config load failed: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}

	if (!watchlist) {
		fail('No issue_watchlist configured in .pappardelle.yml');
		process.exit(1);
	}

	pass('issue_watchlist found');
	info('assignee', watchlist.assignee ?? '(all)');
	info('statuses', watchlist.statuses);
	info('labels', watchlist.labels);

	// ── Step 2: Determine provider ────────────────────────────
	header('Step 2: Initialize provider');
	let provider: IssueTrackerProvider;
	let providerName: string;

	// Detect which provider is configured
	try {
		const {loadProviderConfigs} = await import('../source/config.ts');
		const providerConfigs = loadProviderConfigs();
		if (providerConfigs.issue_tracker?.type === 'jira') {
			const baseUrl = providerConfigs.issue_tracker.base_url;
			if (!baseUrl) {
				fail('Jira configured but no base_url found');
				process.exit(1);
			}

			provider = new JiraProvider(baseUrl as string);
			providerName = 'jira';
		} else {
			provider = new LinearProvider();
			providerName = 'linear';
		}

		pass(`Provider initialized: ${providerName}`);
	} catch (err) {
		fail(
			`Provider initialization failed: ${err instanceof Error ? err.message : err}`,
		);
		process.exit(1);
	}

	// ── Step 3: Fetch assigned issues ─────────────────────────
	const assigneeLabel = watchlist.assignee
		? `"${watchlist.assignee}"`
		: 'undefined';
	header(
		`Step 3: searchAssignedIssues(${assigneeLabel}, ${JSON.stringify(watchlist.statuses)})`,
	);
	const allIssues = await provider.searchAssignedIssues(
		watchlist.assignee,
		watchlist.statuses,
	);

	info('total fetched', allIssues.length);
	if (allIssues.length === 0) {
		pass('No matching issues found (pipeline works, just no data)');
	} else {
		pass(`Fetched ${allIssues.length} issues from ${providerName}`);
		for (const issue of allIssues) {
			issueRow(issue);
		}
	}

	// ── Step 4: Label filtering ───────────────────────────────
	header('Step 4: Label filtering');
	const configLabels = watchlist.labels ?? [];
	info('configured labels', configLabels);

	const afterLabelFilter = filterByLabels(allIssues, configLabels);
	info('before filter', allIssues.length);
	info('after filter', afterLabelFilter.length);

	if (configLabels.length === 0) {
		if (afterLabelFilter.length === allIssues.length) {
			pass('No labels configured — all issues pass through (correct)');
		} else {
			fail('No labels configured but filter changed the count');
		}
	} else {
		const filtered = allIssues.length - afterLabelFilter.length;
		pass(
			`Label filter removed ${filtered} issues, kept ${afterLabelFilter.length}`,
		);
		if (afterLabelFilter.length > 0) {
			console.log('  Kept:');
			for (const issue of afterLabelFilter) {
				issueRow(issue);
			}
		}

		if (filtered > 0) {
			const removed = allIssues.filter(i => !afterLabelFilter.includes(i));
			console.log('  Removed:');
			for (const issue of removed) {
				issueRow(issue);
			}
		}
	}

	// ── Step 5: New workspace detection ───────────────────────
	header('Step 5: New workspace detection');
	info('existing spaces (simulated)', EXISTING_SPACES);

	const newIssues = getNewWatchlistIssues(afterLabelFilter, EXISTING_SPACES);
	info('new issues (would spawn)', newIssues.length);

	if (newIssues.length > 0) {
		console.log('  Would create workspaces for:');
		for (const issue of newIssues) {
			issueRow(issue);
		}
	}

	if (EXISTING_SPACES.length > 0) {
		const skipped = afterLabelFilter.length - newIssues.length;
		pass(`${skipped} issues already have workspaces`);
	}

	pass(`${newIssues.length} new workspaces would be created`);

	// ── Summary ───────────────────────────────────────────────
	header('Pipeline Summary');
	console.log(`  ${providerName} → ${allIssues.length} fetched`);
	console.log(
		`  → label filter (${configLabels.length > 0 ? configLabels.join(', ') : 'none'}) → ${afterLabelFilter.length} remaining`,
	);
	console.log(
		`  → workspace filter (${EXISTING_SPACES.length} existing) → ${newIssues.length} new`,
	);

	if (failed) {
		fail('Some checks failed — see above');
		process.exit(1);
	} else {
		pass('Full pipeline verified');
	}
}

main().catch(err => {
	console.error('Unhandled error:', err);
	process.exit(1);
});
