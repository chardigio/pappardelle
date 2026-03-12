#!/usr/bin/env npx tsx
/**
 * Local verification script for JiraProvider against a real Jira instance.
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-jira.ts`
 *
 * Env vars:
 *   JIRA_BASE_URL  — (required) e.g. https://mycompany.atlassian.net
 *   JIRA_ISSUE     — issue key to fetch (default: auto-detected from searchAssignedIssues)
 *   JIRA_STATUSES  — comma-separated statuses for watchlist (default: To Do,In Progress)
 */

import {JiraProvider} from '../source/providers/jira-provider.ts';

const BASE_URL = process.env['JIRA_BASE_URL'];
if (!BASE_URL) {
	console.error(
		'❌ JIRA_BASE_URL is required. Example:\n  JIRA_BASE_URL=https://mycompany.atlassian.net npx tsx integration-tests/verify-jira.ts',
	);
	process.exit(1);
}

const EXPLICIT_ISSUE = process.env['JIRA_ISSUE'];
const STATUSES = (process.env['JIRA_STATUSES'] ?? 'To Do,In Progress')
	.split(',')
	.map(s => s.trim());

let failed = false;

function header(title: string) {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`  ${title}`);
	console.log('='.repeat(60));
}

function pass(msg: string) {
	console.log(`  ✅ ${msg}`);
}

function fail(msg: string) {
	console.log(`  ❌ ${msg}`);
	failed = true;
}

function info(label: string, value: unknown) {
	console.log(`  ${label}: ${JSON.stringify(value)}`);
}

function verifyLabels(identifier: string, labels: unknown): void {
	if (labels === undefined) {
		pass(`${identifier}: labels is undefined (no labels on issue)`);
	} else if (Array.isArray(labels)) {
		const allStrings = (labels as unknown[]).every(l => typeof l === 'string');
		if (allStrings) {
			pass(
				`${identifier}: labels is string[] with ${(labels as string[]).length} entries`,
			);
		} else {
			fail(`${identifier}: labels array contains non-string entries`);
		}
	} else {
		fail(
			`${identifier}: labels is ${typeof labels} — expected string[] or undefined`,
		);
	}
}

async function main() {
	console.log('Jira Provider — Local Verification');
	console.log(`Base URL: ${BASE_URL}`);
	console.log(`Statuses: ${STATUSES.join(', ')}`);
	if (EXPLICIT_ISSUE) {
		console.log(`Issue: ${EXPLICIT_ISSUE}`);
	}

	const provider = new JiraProvider(BASE_URL);

	// ── searchAssignedIssues ──────────────────────────────────
	header(`searchAssignedIssues("me", ${JSON.stringify(STATUSES)})`);
	const assigned = await provider.searchAssignedIssues('me', STATUSES);

	info('count', assigned.length);

	if (assigned.length === 0) {
		pass('No assigned issues found (this may be expected)');
	} else {
		pass(`Found ${assigned.length} assigned issues`);
		for (const iss of assigned) {
			const labelSummary =
				iss.labels === undefined ? '(no labels)' : `[${iss.labels.join(', ')}]`;
			console.log(
				`    ${iss.identifier} — ${iss.title} (${iss.state.name}) ${labelSummary}`,
			);
			verifyLabels(iss.identifier, iss.labels);
		}
	}

	// ── searchAssignedIssues (no assignee) ───────────────────
	header(`searchAssignedIssues(undefined, ${JSON.stringify(STATUSES)})`);
	const unfiltered = await provider.searchAssignedIssues(undefined, STATUSES);

	info('count', unfiltered.length);

	if (unfiltered.length >= assigned.length) {
		pass(
			`No-assignee search returned ${unfiltered.length} issues (≥ ${assigned.length} from "me")`,
		);
	} else {
		fail(
			`No-assignee search returned fewer issues (${unfiltered.length}) than "me" search (${assigned.length})`,
		);
	}

	// Determine issue key to test getIssue with
	const issueKey =
		EXPLICIT_ISSUE ?? (assigned.length > 0 ? assigned[0]!.identifier : null);

	if (!issueKey) {
		console.log(
			'\n⚠️  No issue key available. Set JIRA_ISSUE env var or ensure you have assigned issues.',
		);
		header('Summary');
		if (failed) {
			fail('Some checks failed — see above');
			process.exit(1);
		} else {
			pass('All checks passed (limited — no issue key available)');
		}

		return;
	}

	// ── getIssue ──────────────────────────────────────────────
	header(`getIssue("${issueKey}")`);

	// Clear cache so we get a fresh fetch
	provider.clearCache();
	const issue = await provider.getIssue(issueKey);

	if (!issue) {
		fail(`getIssue returned null — is acli on PATH and authenticated?`);
		process.exit(1);
	}

	pass('Issue fetched successfully');
	info('identifier', issue.identifier);
	info('title', issue.title);
	info('state', issue.state);
	info('project', issue.project);
	info('labels', issue.labels);

	verifyLabels(issue.identifier, issue.labels);

	// ── getIssueCached ────────────────────────────────────────
	header('getIssueCached (should return cached issue)');
	const cached = provider.getIssueCached(issueKey);

	if (cached) {
		pass('Cache hit');
		if (cached.identifier === issue.identifier) {
			pass('Cached issue matches fetched issue');
		} else {
			fail(`Cached identifier ${cached.identifier} !== ${issue.identifier}`);
		}
	} else {
		fail('Cache miss — getIssueCached returned null after getIssue');
	}

	// ── getWorkflowStateColor ─────────────────────────────────
	header('getWorkflowStateColor');
	const color = provider.getWorkflowStateColor(issue.state.name);
	info('state', issue.state.name);
	info('color', color);

	if (color) {
		pass(`Color resolved: ${color}`);
	} else {
		// Jira only has static colors for To Do / In Progress / Done
		pass('No dynamic color (expected for non-standard status categories)');
	}

	// ── buildIssueUrl ─────────────────────────────────────────
	header('buildIssueUrl');
	const url = provider.buildIssueUrl(issueKey);
	info('url', url);

	if (url.startsWith(BASE_URL) && url.includes(issueKey)) {
		pass('URL looks correct');
	} else {
		fail(`URL doesn't match expected pattern: ${BASE_URL}/browse/${issueKey}`);
	}

	// ── getIssues (batch) ─────────────────────────────────────
	if (assigned.length >= 2) {
		const batchKeys = assigned.slice(0, 3).map(i => i.identifier);
		header(`getIssues(${JSON.stringify(batchKeys)})`);

		provider.clearCache();
		const batch = await provider.getIssues(batchKeys);

		info('returned', batch.size);
		if (batch.size === batchKeys.length) {
			pass(`All ${batchKeys.length} issues returned`);
		} else {
			fail(`Expected ${batchKeys.length} issues, got ${batch.size}`);
		}

		for (const [key, iss] of batch) {
			if (iss) {
				pass(`${key}: ${iss.title}`);
				verifyLabels(key, iss.labels);
			} else {
				fail(`${key}: null`);
			}
		}
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

main().catch(err => {
	console.error('Unhandled error:', err);
	process.exit(1);
});
