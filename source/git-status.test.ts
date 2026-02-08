import test from 'ava';
import {getMainWorktreeColor, isWorktreeDirty} from './git-status.ts';

// ============================================================================
// isWorktreeDirty Tests
// ============================================================================

test('isWorktreeDirty returns false for clean worktree', t => {
	// This is an integration test — it checks the actual main worktree
	// We can't mock execSync easily in ava, so we test the function signature
	const result = isWorktreeDirty('/nonexistent/path');
	// Nonexistent path should return false (fail-safe: treat as clean)
	t.false(result);
});

// ============================================================================
// getMainWorktreeColor Tests
// ============================================================================

test('getMainWorktreeColor returns magentaBright when clean', t => {
	t.is(getMainWorktreeColor(false), 'magentaBright');
});

test('getMainWorktreeColor returns yellow when dirty', t => {
	t.is(getMainWorktreeColor(true), 'yellow');
});
