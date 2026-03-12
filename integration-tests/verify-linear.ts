#!/usr/bin/env npx tsx
/**
 * Local verification script for LinearProvider against a real Linear instance.
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-linear.ts`
 *
 * Env vars:
 *   LINEAR_ISSUE   — issue key to fetch (default: STA-683)
 *   LINEAR_STATUSES — comma-separated statuses for watchlist (default: Todo,In Progress)
 */

import {LinearProvider} from '../source/providers/linear-provider.ts';

const ISSUE_KEY = process.env['LINEAR_ISSUE'] ?? 'STA-683';
const STATUSES = (process.env['LINEAR_STATUSES'] ?? 'Todo,In Progress')
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

async function main() {
	console.log('Linear Provider — Local Verification');
	console.log(`Issue: ${ISSUE_KEY} | Statuses: ${STATUSES.join(', ')}`);

	const provider = new LinearProvider();

	// ── getIssue ──────────────────────────────────────────────
	header(`getIssue("${ISSUE_KEY}")`);
	const issue = await provider.getIssue(ISSUE_KEY);

	if (!issue) {
		fail(`getIssue returned null — is linctl on PATH and authenticated?`);
		process.exit(1);
	}

	pass('Issue fetched successfully');
	info('identifier', issue.identifier);
	info('title', issue.title);
	info('state', issue.state);
	info('project', issue.project);
	info('labels', issue.labels);

	// Verify label shape
	if (issue.labels === undefined) {
		pass('labels is undefined (issue has no labels — this is valid)');
	} else if (Array.isArray(issue.labels)) {
		const allStrings = issue.labels.every(l => typeof l === 'string');
		if (allStrings) {
			pass(`labels is string[] with ${issue.labels.length} entries`);
		} else {
			fail('labels array contains non-string entries — parsing is broken');
		}
	} else {
		fail(`labels is ${typeof issue.labels} — expected string[] or undefined`);
	}

	// ── getIssueCached ────────────────────────────────────────
	header('getIssueCached (should return cached issue)');
	const cached = provider.getIssueCached(ISSUE_KEY);

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
		fail('No color resolved for state');
	}

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

			// Verify each issue has proper label shape
			if (iss.labels !== undefined && !Array.isArray(iss.labels)) {
				fail(`${iss.identifier}: labels is ${typeof iss.labels}, not array`);
			}

			if (
				Array.isArray(iss.labels) &&
				!iss.labels.every(l => typeof l === 'string')
			) {
				fail(`${iss.identifier}: labels array contains non-string entries`);
			}
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
