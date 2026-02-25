import test from 'ava';
import {getMainWorktreeColor, isWorktreeDirty} from './git-status.ts';

// ============================================================================
// isWorktreeDirty Tests
// ============================================================================

test('isWorktreeDirty returns false for nonexistent path', async t => {
	// Nonexistent path should return false (fail-safe: treat as clean)
	const result = await isWorktreeDirty('/nonexistent/path');
	t.false(result);
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
