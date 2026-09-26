import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runPreWorkspaceDeinit} from './workspace-deinit.ts';
import type {CommandConfig} from './config.ts';

test('verbose deinit hooks finish in order and preserve failure policy', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-deinit-'));
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	fs.writeFileSync(
		path.join(dir, 'hook.cjs'),
		`
const fs = require('node:fs');
const chunk = Buffer.alloc(64 * 1024, 'x');
for (let i = 0; i < 128; i++) {
  fs.writeSync(1, chunk);
  fs.writeSync(2, chunk);
}
fs.appendFileSync('order', process.argv[2]);
process.exit(Number(process.argv[3]));
`,
	);
	const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
	const result = await runPreWorkspaceDeinit(
		[
			{name: 'first', run: `${node} hook.cjs A 0`},
			{
				name: 'allowed failure',
				run: `${node} hook.cjs B 7`,
				continue_on_error: true,
			},
			{name: 'stop here', run: `${node} hook.cjs C 9`},
			{name: 'must not run', run: `${node} hook.cjs D 0`},
		],
		dir,
	);
	t.deepEqual(result, {success: false, failedCommand: 'stop here'});
	t.is(fs.readFileSync(path.join(dir, 'order'), 'utf8'), 'ABC');
});

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
		// eslint-disable-next-line no-template-curly-in-string
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
			// eslint-disable-next-line no-template-curly-in-string
			run: 'test "${WORKTREE_PATH}" = "/tmp"',
		},
	];
	const result = await runPreWorkspaceDeinit(commands, '/tmp');
	t.true(result.success);
});
