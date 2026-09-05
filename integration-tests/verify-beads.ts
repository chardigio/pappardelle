#!/usr/bin/env npx tsx
/**
 * Local verification script for BeadsProvider against a real beads database.
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-beads.ts`
 *
 * Read-only by default: nothing is created, updated, or commented on unless
 * BEADS_WRITE=1 is set. Beads databases are real project data, and the global
 * `~/.beads` fallback means a stray `bd create` can land in a database you did
 * not mean to touch.
 *
 * Env vars:
 *   BEADS_ISSUE     — issue ID to fetch (default: first result from `bd list`)
 *   BEADS_STATUSES  — comma-separated statuses for the watchlist (default: none = all ready)
 *   BEADS_ASSIGNEE  — assignee filter for the watchlist (default: none)
 *   BEADS_WRITE     — set to 1 to also exercise createComment on BEADS_ISSUE
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BeadsProvider} from '../source/providers/beads-provider.ts';
import {
	getRepoRoot,
	loadConfig,
	matchProfileByProject,
} from '../source/config.ts';

const execFileAsync = promisify(execFile);

const EXPLICIT_ISSUE = process.env['BEADS_ISSUE'];
const STATUSES = (process.env['BEADS_STATUSES'] ?? '')
	.split(',')
	.map(s => s.trim())
	.filter(s => s !== '');
const ASSIGNEE = process.env['BEADS_ASSIGNEE'];
const ALLOW_WRITES = process.env['BEADS_WRITE'] === '1';

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

function skip(msg: string) {
	console.log(`  ⏭️  ${msg}`);
}

function info(label: string, value: unknown) {
	console.log(`  ${label}: ${JSON.stringify(value)}`);
}

async function firstIssueId(cwd: string): Promise<string | undefined> {
	const {stdout} = await execFileAsync('bd', ['list', '--json', '-n', '5'], {
		cwd,
		env: {...process.env, BD_JSON_ENVELOPE: '1'},
	});
	const parsed = JSON.parse(stdout) as {data?: unknown} | unknown[];
	const rows = Array.isArray(parsed) ? parsed : (parsed.data as unknown[]);
	const first = rows?.[0] as {id?: string} | undefined;
	return first?.id;
}

async function main() {
	console.log('Beads Provider — Local Verification');

	let repoRoot: string;
	try {
		repoRoot = getRepoRoot();
	} catch {
		console.error('❌ Not in a git repository — beads needs one.');
		process.exit(1);
	}

	console.log(`Repo root: ${repoRoot}`);
	console.log(`Writes: ${ALLOW_WRITES ? 'ENABLED' : 'disabled (read-only)'}`);

	const provider = new BeadsProvider();

	// ------------------------------------------------------------------
	header('bd availability');
	let issueId: string | undefined;
	try {
		issueId = EXPLICIT_ISSUE ?? (await firstIssueId(repoRoot));
		pass('bd list succeeded');
	} catch (error) {
		fail(`bd is not usable from ${repoRoot}: ${String(error)}`);
		process.exit(1);
	}

	if (!issueId) {
		fail('No issues found — create one with `bd create` and re-run.');
		process.exit(1);
	}

	info('Issue under test', issueId);

	// ------------------------------------------------------------------
	header('getIssue');
	const issue = await provider.getIssue(issueId);
	if (!issue) {
		fail(`getIssue(${issueId}) returned null`);
		process.exit(1);
	}

	info('identifier', issue.identifier);
	info('title', issue.title);
	info('state', issue.state);
	info('project', issue.project);
	info('labels', issue.labels);

	if (issue.identifier === issueId) {
		pass('identifier round-trips verbatim (no case mangling)');
	} else {
		fail(`identifier changed: asked ${issueId}, got ${issue.identifier}`);
	}

	if (issue.title.length > 0) {
		pass('title is non-empty');
	} else {
		fail('title is empty');
	}

	// Copied from verify-linear, where states carry real hex colors. Beads has
	// no per-status color of its own, so BEADS_STATUS_COLORS answers with ANSI
	// names deliberately — they follow the user's terminal theme. Asserting hex
	// here failed on every healthy database.
	if (/^[a-z]+$/i.test(issue.state.color)) {
		pass(`state color resolved (${issue.state.color})`);
	} else {
		fail(`state color is not an ANSI color name: ${issue.state.color}`);
	}

	const expectedPrefix = issueId
		.split('.')[0]!
		.slice(0, issueId.split('.')[0]!.lastIndexOf('-'));
	if (issue.project?.key === expectedPrefix) {
		pass(`project derived from the ID prefix (${expectedPrefix})`);
	} else {
		fail(
			`project key ${String(issue.project?.key)} != prefix ${expectedPrefix}`,
		);
	}

	// ------------------------------------------------------------------
	header('Profile resolution from the ID prefix');
	try {
		const config = loadConfig();
		const match = issue.project
			? matchProfileByProject(config, issue.project.name, issue.project.key)
			: null;
		if (match) {
			pass(`prefix routes to profile "${match.name}"`);
		} else {
			skip(
				`no profile lists "${issue.project?.key}" in tracker_projects — the default profile will be used`,
			);
		}
	} catch (error) {
		skip(`config not loadable here: ${String(error)}`);
	}

	// ------------------------------------------------------------------
	header('getIssueCached');
	if (provider.getIssueCached(issueId)?.identifier === issueId) {
		pass('cached read returns the fetched issue');
	} else {
		fail('cached read missed after a successful getIssue');
	}

	// ------------------------------------------------------------------
	header('getIssues (batch)');
	const batch = await provider.getIssues([issueId]);
	if (batch.get(issueId)?.title === issue.title) {
		pass('batch fetch agrees with the single fetch');
	} else {
		fail('batch fetch disagreed with the single fetch');
	}

	const missing = await provider.getIssues([`${issueId}-nonexistent`]);
	if (missing.get(`${issueId}-nonexistent`) === null) {
		pass('unknown key maps to null rather than throwing');
	} else {
		fail('unknown key did not map to null');
	}

	// ------------------------------------------------------------------
	header('searchAssignedIssues (bd ready)');
	const ready = await provider.searchAssignedIssues(ASSIGNEE, STATUSES);
	info('ready count', ready.length);
	for (const r of ready.slice(0, 5)) {
		console.log(`    ${r.identifier}  [${r.state.name}]  ${r.title}`);
	}

	if (STATUSES.length > 0) {
		const offList = ready.filter(
			r =>
				!STATUSES.some(
					s =>
						s.toLowerCase() === r.state.type.toLowerCase() ||
						s.toLowerCase() === r.state.name.toLowerCase(),
				),
		);
		if (offList.length === 0) {
			pass(
				`every result matches the configured statuses (${STATUSES.join(', ')})`,
			);
		} else {
			fail(`${offList.length} results fall outside the configured statuses`);
		}
	} else {
		pass('no status filter configured — every ready issue returned');
	}

	if (ready.every(r => r.state.type !== 'completed')) {
		pass('no closed issues in the ready set');
	} else {
		fail('bd ready returned a closed issue');
	}

	// ------------------------------------------------------------------
	header('buildIssueUrl');
	if (provider.buildIssueUrl() === '') {
		pass('no URL, as expected for a local tracker');
	} else {
		fail('buildIssueUrl returned something — beads issues have no web page');
	}

	// ------------------------------------------------------------------
	header('createComment');
	if (ALLOW_WRITES) {
		const body = `Pappardelle verify-beads smoke test — ${new Date().toISOString()}`;
		if (await provider.createComment(issueId, body)) {
			pass(
				`comment posted to ${issueId} (check with \`bd comments ${issueId}\`)`,
			);
		} else {
			fail('createComment returned false');
		}
	} else {
		skip('set BEADS_WRITE=1 to exercise createComment');
	}

	// ------------------------------------------------------------------
	header('Summary');
	if (failed) {
		console.log('  ❌ Some checks failed');
		process.exit(1);
	}

	console.log('  ✅ All checks passed');
}

await main();
