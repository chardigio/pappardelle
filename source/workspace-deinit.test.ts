import test from 'ava';
import {runPreWorkspaceDeinit} from './workspace-deinit.ts';
import type {CommandConfig} from './config.ts';

// ============================================================================
// runPreWorkspaceDeinit tests
// ============================================================================

test('returns success when no commands are provided', async t => {
	const result = await runPreWorkspaceDeinit([], '/tmp');
	t.true(result.success);
	t.is(result.failedCommand, undefined);
});

test('returns success when all commands succeed', async t => {
	const commands: CommandConfig[] = [
		{name: 'Echo test', run: 'echo hello'},
		{name: 'True', run: 'true'},
	];
	const result = await runPreWorkspaceDeinit(commands, '/tmp');
	t.true(result.success);
	t.is(result.failedCommand, undefined);
});

test('returns failure when a command fails', async t => {
	const commands: CommandConfig[] = [{name: 'Will fail', run: 'false'}];
	const result = await runPreWorkspaceDeinit(commands, '/tmp');
	t.false(result.success);
	t.is(result.failedCommand, 'Will fail');
});

test('continues past failure when continue_on_error is true', async t => {
	const commands: CommandConfig[] = [
		{name: 'Will fail', run: 'false', continue_on_error: true},
		{name: 'Should run', run: 'true'},
	];
	const result = await runPreWorkspaceDeinit(commands, '/tmp');
	t.true(result.success);
});

test('stops at first failure when continue_on_error is not set', async t => {
	const commands: CommandConfig[] = [
		{name: 'Step 1', run: 'true'},
		{name: 'Step 2 fails', run: 'false'},
		{name: 'Step 3 never runs', run: 'echo should-not-run'},
	];
	const result = await runPreWorkspaceDeinit(commands, '/tmp');
	t.false(result.success);
	t.is(result.failedCommand, 'Step 2 fails');
});

test('expands template variables in commands', async t => {
	const commands: CommandConfig[] = [
		{name: 'Check expansion', run: 'test "${ISSUE_KEY}" = "STA-123"'},
	];
	const result = await runPreWorkspaceDeinit(commands, '/tmp', {
		issueKey: 'STA-123',
	});
	t.true(result.success);
});

test('expands WORKTREE_PATH template variable', async t => {
	const commands: CommandConfig[] = [
		{
			name: 'Check worktree path',
			run: 'test "${WORKTREE_PATH}" = "/tmp"',
		},
	];
	const result = await runPreWorkspaceDeinit(commands, '/tmp');
	t.true(result.success);
});
