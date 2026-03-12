#!/usr/bin/env npx tsx
/**
 * Local verification of workspace-deinit against real shell execution.
 * Tests: command execution, variable expansion, continue_on_error, real cwd handling.
 *
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-workspace-deinit.ts`
 *
 * Creates a temp directory to simulate a worktree, then cleans up after.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runPreWorkspaceDeinit} from '../source/workspace-deinit.ts';
import type {CommandConfig} from '../source/config.ts';

let failed = false;
let passCount = 0;
let failCount = 0;

function header(title: string) {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`  ${title}`);
	console.log('='.repeat(60));
}

function pass(msg: string) {
	console.log(`  ✅ ${msg}`);
	passCount++;
}

function fail(msg: string) {
	console.log(`  ❌ ${msg}`);
	failed = true;
	failCount++;
}

function assert(condition: boolean, passMsg: string, failMsg: string) {
	if (condition) {
		pass(passMsg);
	} else {
		fail(failMsg);
	}
}

async function main() {
	console.log('Workspace Deinit — Local Verification');

	// Create a real temp directory to act as the worktree
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-deinit-'));
	console.log(`  Temp worktree dir: ${tmpDir}`);

	try {
		// ── Basic execution ──────────────────────────────────────
		header('Basic command execution');

		{
			const result = await runPreWorkspaceDeinit([], tmpDir);
			assert(
				result.success && result.failedCommand === undefined,
				'Empty command list returns success',
				`Empty command list: success=${result.success}, failedCommand=${result.failedCommand}`,
			);
		}

		{
			const commands: CommandConfig[] = [
				{name: 'Echo', run: 'echo hello'},
				{name: 'True', run: 'true'},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(
				result.success,
				'Successful commands return success',
				'Successful commands did not return success',
			);
		}

		{
			const commands: CommandConfig[] = [{name: 'Fail', run: 'false'}];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(
				!result.success && result.failedCommand === 'Fail',
				'Failed command returns failure with command name',
				`Expected failure with name "Fail", got success=${result.success} failedCommand=${result.failedCommand}`,
			);
		}

		// ── continue_on_error ────────────────────────────────────
		header('continue_on_error behavior');

		{
			const commands: CommandConfig[] = [
				{name: 'Fail soft', run: 'false', continue_on_error: true},
				{name: 'After soft fail', run: 'true'},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(
				result.success,
				'continue_on_error=true skips past failure',
				'continue_on_error=true did not skip past failure',
			);
		}

		{
			const commands: CommandConfig[] = [
				{name: 'OK', run: 'true'},
				{name: 'Hard fail', run: 'false'},
				{name: 'Never reached', run: 'echo should-not-run'},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(
				!result.success && result.failedCommand === 'Hard fail',
				'Hard failure stops execution at failing command',
				`Expected stop at "Hard fail", got success=${result.success} failedCommand=${result.failedCommand}`,
			);
		}

		// ── Template variable expansion ──────────────────────────
		header('Template variable expansion');

		{
			// WORKTREE_PATH should always be available
			const marker = path.join(tmpDir, 'worktree-path-check.txt');
			const commands: CommandConfig[] = [
				{
					name: 'Write worktree path',
					run: `echo -n "\${WORKTREE_PATH}" > "${marker}"`,
				},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(
				result.success,
				'WORKTREE_PATH command succeeded',
				'WORKTREE_PATH command failed',
			);

			if (fs.existsSync(marker)) {
				const content = fs.readFileSync(marker, 'utf8');
				assert(
					content === tmpDir,
					`WORKTREE_PATH expanded correctly: ${content}`,
					`WORKTREE_PATH mismatch: expected "${tmpDir}", got "${content}"`,
				);
				fs.unlinkSync(marker);
			} else {
				fail('WORKTREE_PATH marker file was not created');
			}
		}

		{
			// ISSUE_KEY and ISSUE_NUMBER from context
			const marker = path.join(tmpDir, 'issue-check.txt');
			const commands: CommandConfig[] = [
				{
					name: 'Write issue vars',
					run: `echo -n "\${ISSUE_KEY}|\${ISSUE_NUMBER}" > "${marker}"`,
				},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir, {
				issueKey: 'STA-687',
			});
			assert(
				result.success,
				'ISSUE_KEY command succeeded',
				'ISSUE_KEY command failed',
			);

			if (fs.existsSync(marker)) {
				const content = fs.readFileSync(marker, 'utf8');
				assert(
					content === 'STA-687|687',
					`ISSUE_KEY and ISSUE_NUMBER expanded: ${content}`,
					`Issue var mismatch: expected "STA-687|687", got "${content}"`,
				);
				fs.unlinkSync(marker);
			} else {
				fail('Issue marker file was not created');
			}
		}

		{
			// REPO_ROOT and REPO_NAME from context
			const marker = path.join(tmpDir, 'repo-check.txt');
			const commands: CommandConfig[] = [
				{
					name: 'Write repo vars',
					run: `echo -n "\${REPO_ROOT}|\${REPO_NAME}" > "${marker}"`,
				},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir, {
				issueKey: 'TEST-1',
				repoRoot: '/home/user/myrepo',
				repoName: 'myrepo',
			});
			assert(
				result.success,
				'REPO_ROOT/REPO_NAME command succeeded',
				'REPO_ROOT/REPO_NAME command failed',
			);

			if (fs.existsSync(marker)) {
				const content = fs.readFileSync(marker, 'utf8');
				assert(
					content === '/home/user/myrepo|myrepo',
					`REPO_ROOT and REPO_NAME expanded: ${content}`,
					`Repo var mismatch: expected "/home/user/myrepo|myrepo", got "${content}"`,
				);
				fs.unlinkSync(marker);
			} else {
				fail('Repo marker file was not created');
			}
		}

		{
			// Missing context fields should expand to empty strings (not crash)
			const marker = path.join(tmpDir, 'empty-check.txt');
			const commands: CommandConfig[] = [
				{
					name: 'Write empty vars',
					run: `echo -n "[\${ISSUE_KEY}][\${REPO_ROOT}][\${REPO_NAME}]" > "${marker}"`,
				},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(
				result.success,
				'Missing context fields do not crash',
				'Missing context fields caused failure',
			);

			if (fs.existsSync(marker)) {
				const content = fs.readFileSync(marker, 'utf8');
				assert(
					content === '[][][]',
					`Missing vars expand to empty: ${content}`,
					`Expected "[][][]", got "${content}"`,
				);
				fs.unlinkSync(marker);
			} else {
				fail('Empty var marker file was not created');
			}
		}

		// ── Real cwd behavior ────────────────────────────────────
		header('Working directory behavior');

		{
			// Commands should run in the worktree path when it exists
			const marker = path.join(tmpDir, 'cwd-check.txt');
			const commands: CommandConfig[] = [
				{name: 'Check cwd', run: `pwd > "${marker}"`},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(result.success, 'cwd command succeeded', 'cwd command failed');

			if (fs.existsSync(marker)) {
				const content = fs.readFileSync(marker, 'utf8').trim();
				// macOS may resolve /tmp → /private/tmp
				const resolvedTmp = fs.realpathSync(tmpDir);
				assert(
					content === tmpDir || content === resolvedTmp,
					`cwd is worktree path: ${content}`,
					`Expected cwd "${tmpDir}" or "${resolvedTmp}", got "${content}"`,
				);
				fs.unlinkSync(marker);
			} else {
				fail('cwd marker file was not created');
			}
		}

		{
			// When worktree path doesn't exist, should fall back to process.cwd()
			const fakePath = path.join(tmpDir, 'does-not-exist');
			const commands: CommandConfig[] = [
				{name: 'Check fallback cwd', run: 'pwd'},
			];
			const result = await runPreWorkspaceDeinit(commands, fakePath);
			assert(
				result.success,
				'Non-existent worktree path falls back gracefully',
				'Non-existent worktree path caused failure',
			);
		}

		// ── Side effects (file creation/cleanup) ─────────────────
		header('Real side effects');

		{
			// Simulate a real deinit task: create then verify a file
			const sideEffectFile = path.join(tmpDir, 'cleanup-log.txt');
			const commands: CommandConfig[] = [
				{
					name: 'Log cleanup',
					run: `echo "deinit ran at $(date +%s)" > "${sideEffectFile}"`,
				},
				{name: 'Verify log', run: `test -f "${sideEffectFile}"`},
			];
			const result = await runPreWorkspaceDeinit(commands, tmpDir);
			assert(
				result.success,
				'Multi-step deinit with side effects works',
				'Multi-step deinit failed',
			);

			if (fs.existsSync(sideEffectFile)) {
				const content = fs.readFileSync(sideEffectFile, 'utf8');
				assert(
					content.startsWith('deinit ran at'),
					`Side effect file has expected content`,
					`Unexpected content: ${content}`,
				);
			} else {
				fail('Side effect file was not created');
			}
		}

		// ── Summary ──────────────────────────────────────────────
		header('Summary');
		console.log(`  ${passCount} passed, ${failCount} failed`);
		if (failed) {
			fail('Some checks failed — see above');
		} else {
			pass('All workspace-deinit checks passed');
		}
	} finally {
		// Clean up temp directory
		fs.rmSync(tmpDir, {recursive: true, force: true});
		console.log(`\n  Cleaned up ${tmpDir}`);
	}

	if (failed) {
		process.exit(1);
	}
}

main().catch(err => {
	console.error('Unhandled error:', err);
	process.exit(1);
});
