import test from 'ava';
import {getMainWorktreeColor, isWorktreeDirty} from './git-status.ts';

// ============================================================================
// isWorktreeDirty Tests
// ============================================================================

test('isWorktreeDirty returns unknown for nonexistent path', async t => {
	const result = await isWorktreeDirty('/nonexistent/path');
	t.is(result, null);
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
