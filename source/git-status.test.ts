import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test, expect} from 'bun:test';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {getMainWorktreeColor, isWorktreeDirty} from './git-status.ts';

// ============================================================================
// isWorktreeDirty Tests
// ============================================================================

test('isWorktreeDirty returns unknown for nonexistent path', async () => {
	const result = await isWorktreeDirty('/nonexistent/path');
	expect(result).toBe(null);
});

test('isWorktreeDirty tells a dirty worktree from a clean one', async () => {
	const repo = tempDir('pappardelle-dirty-');
	execFileSync('git', ['init', '--quiet', repo]);
	expect(await isWorktreeDirty(repo)).toBe(false);
	writeFileSync(join(repo, 'new.txt'), 'x');
	expect(await isWorktreeDirty(repo)).toBe(true);
});

// ============================================================================
// getMainWorktreeColor Tests
// ============================================================================

test('getMainWorktreeColor returns cleanColor when clean', () => {
	expect(getMainWorktreeColor(false, '#f2c94c', '#5e6ad2')).toBe('#5e6ad2');
});

test('getMainWorktreeColor returns dirtyColor when dirty', () => {
	expect(getMainWorktreeColor(true, '#f2c94c', '#5e6ad2')).toBe('#f2c94c');
});
