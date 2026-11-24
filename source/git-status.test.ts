import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'ava';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {getMainWorktreeColor, isWorktreeDirty} from './git-status.ts';

// ============================================================================
// isWorktreeDirty Tests
// ============================================================================

test('isWorktreeDirty returns unknown for nonexistent path', async t => {
	const result = await isWorktreeDirty('/nonexistent/path');
	t.is(result, null);
});

test('isWorktreeDirty tells a dirty worktree from a clean one', async t => {
	const repo = tempDir(t, 'pappardelle-dirty-');
	execFileSync('git', ['init', '--quiet', repo]);
	t.false(await isWorktreeDirty(repo));
	writeFileSync(join(repo, 'new.txt'), 'x');
	t.true(await isWorktreeDirty(repo));
});

// ============================================================================
// getMainWorktreeColor Tests
// ============================================================================

test('getMainWorktreeColor returns cleanColor when clean', t => {
	t.is(getMainWorktreeColor(false, '#f2c94c', '#5e6ad2'), '#5e6ad2');
});

test('getMainWorktreeColor returns dirtyColor when dirty', t => {
	t.is(getMainWorktreeColor(true, '#f2c94c', '#5e6ad2'), '#f2c94c');
});
