import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	getSessionNames,
	extractIssueKeyFromSession,
	getSessionPrefix,
	pretrustDirectoryForClaude,
	pretrustDirectoryForAgent,
	isAgentForegroundInSession,
	getInnerSessionForegroundCommands,
} from './tmux.ts';
import {buildAgentResumeCommand} from './agents/registry.ts';

// getSessionPrefix: returns repo-qualified prefix
test('getSessionPrefix includes repo name for claude', t => {
	const prefix = getSessionPrefix('claude', 'pappa-chex');
	t.is(prefix, 'claude-pappa-chex-');
});

test('getSessionPrefix includes repo name for companion', t => {
	const prefix = getSessionPrefix('companion', 'pappa-chex');
	t.is(prefix, 'companion-pappa-chex-');
});

// getSessionNames: repo-qualified session names
test('getSessionNames qualifies issue key with repo name', t => {
	const names = getSessionNames('CHEX-313', 'pappa-chex');
	t.is(names.claude, 'claude-pappa-chex-CHEX-313');
	t.is(names.companion, 'companion-pappa-chex-CHEX-313');
});

test('getSessionNames qualifies main branch with repo name', t => {
	const names = getSessionNames('main', 'pappa-chex');
	t.is(names.claude, 'claude-pappa-chex-main');
	t.is(names.companion, 'companion-pappa-chex-main');
});

test('getSessionNames works with different repo names', t => {
	const names = getSessionNames('STA-100', 'stardust-labs');
	t.is(names.claude, 'claude-stardust-labs-STA-100');
	t.is(names.companion, 'companion-stardust-labs-STA-100');
});

// extractIssueKeyFromSession: strips repo-qualified prefix
test('extractIssueKeyFromSession strips repo prefix from claude session', t => {
	t.is(
		extractIssueKeyFromSession('claude-pappa-chex-CHEX-313', 'pappa-chex'),
		'CHEX-313',
	);
});

test('extractIssueKeyFromSession strips repo prefix from main session', t => {
	t.is(
		extractIssueKeyFromSession('claude-pappa-chex-main', 'pappa-chex'),
		'main',
	);
});

test('extractIssueKeyFromSession returns null for non-matching session', t => {
	t.is(
		extractIssueKeyFromSession('claude-other-repo-STA-100', 'pappa-chex'),
		null,
	);
});

test('extractIssueKeyFromSession returns null for bare claude prefix', t => {
	t.is(extractIssueKeyFromSession('claude-CHEX-313', 'pappa-chex'), null);
});

// pretrustDirectoryForClaude: workspace trust management

function makeTempConfigPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'pretrust-test-'));
	return join(dir, '.claude.json');
}

test('pretrustDirectoryForClaude creates config with trust entry when file does not exist', t => {
	const configPath = makeTempConfigPath();
	pretrustDirectoryForClaude('/tmp/worktree/STA-100', configPath);
	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.deepEqual(config.projects['/tmp/worktree/STA-100'], {
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude adds trust entry without clobbering existing config', t => {
	const configPath = makeTempConfigPath();
	const existing = {
		someOtherSetting: 'keep-me',
		projects: {
			'/existing/path': {hasTrustDialogAccepted: true, customSetting: 42},
		},
	};
	writeFileSync(configPath, JSON.stringify(existing));

	pretrustDirectoryForClaude('/tmp/worktree/STA-200', configPath);

	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.is(config.someOtherSetting, 'keep-me');
	t.deepEqual(config.projects['/existing/path'], {
		hasTrustDialogAccepted: true,
		customSetting: 42,
	});
	t.deepEqual(config.projects['/tmp/worktree/STA-200'], {
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude is idempotent when path already trusted', t => {
	const configPath = makeTempConfigPath();
	const existing = {
		projects: {
			'/already/trusted': {hasTrustDialogAccepted: true},
		},
	};
	writeFileSync(configPath, JSON.stringify(existing));

	pretrustDirectoryForClaude('/already/trusted', configPath);

	// File should not have been rewritten (content unchanged)
	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.deepEqual(config.projects['/already/trusted'], {
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude handles corrupt JSON gracefully', t => {
	const configPath = makeTempConfigPath();
	writeFileSync(configPath, 'this is not valid json{{{');

	// Should not throw — falls back to fresh config
	t.notThrows(() => {
		pretrustDirectoryForClaude('/tmp/worktree/STA-300', configPath);
	});

	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.deepEqual(config.projects['/tmp/worktree/STA-300'], {
		hasTrustDialogAccepted: true,
	});
});

// buildAgentResumeCommand: generates --continue fallback chain

test('buildAgentResumeCommand tries --continue first', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-806');
	t.true(cmd.startsWith('claude --name STA-806 --continue'));
});

test('buildAgentResumeCommand falls back to bare claude with --name', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-806');
	t.true(cmd.endsWith('|| claude --name STA-806'));
});

test('buildAgentResumeCommand includes ANSI escape to clear error line', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-806');
	t.true(cmd.includes("printf '\\033[A\\033[2K'"));
});

test('buildAgentResumeCommand with skipPermissions includes flag in both branches', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-806', true);
	// --continue attempt should have both flags
	t.true(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --name STA-806 --continue',
		),
	);
	// Fallback should also have both flags
	t.true(
		cmd.endsWith('|| claude --dangerously-skip-permissions --name STA-806'),
	);
});

test('buildAgentResumeCommand without skipPermissions has no permission flag', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-806', false);
	t.false(cmd.includes('--dangerously-skip-permissions'));
});

test('buildAgentResumeCommand default is skipPermissions=false', t => {
	t.is(
		buildAgentResumeCommand('claude', 'STA-806'),
		buildAgentResumeCommand('claude', 'STA-806', false),
	);
});

test('buildAgentResumeCommand sets --name to the issue key on both branches', t => {
	const cmd = buildAgentResumeCommand('claude', 'CHEX-42');
	// --name appears in both the --continue attempt and the fallback
	const occurrences = cmd.match(/--name CHEX-42/g) ?? [];
	t.is(occurrences.length, 2);
});

test('buildAgentResumeCommand shell-quotes non-standard issue keys', t => {
	// An issue key with shell metacharacters should be safely quoted.
	const cmd = buildAgentResumeCommand('claude', 'weird key; rm -rf /');
	// Must not contain the raw unquoted metacharacters inline as an arg.
	t.false(cmd.includes('--name weird key; rm -rf /'));
	// Must still reference --name twice.
	t.is((cmd.match(/--name /g) ?? []).length, 2);
});

// pretrustDirectoryForAgent: registry-gated, not assumed for every harness

test('pretrustDirectoryForAgent pre-trusts for Claude', t => {
	const configPath = join(
		mkdtempSync(join(tmpdir(), 'papp-trust-')),
		'.claude.json',
	);
	pretrustDirectoryForAgent('claude', '/tmp/worktree/STA-400', configPath);

	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.true(config.projects['/tmp/worktree/STA-400'].hasTrustDialogAccepted);
});

test('pretrustDirectoryForAgent is a no-op for Codex — it has no trust prompt', t => {
	const dir = mkdtempSync(join(tmpdir(), 'papp-trust-'));
	const configPath = join(dir, '.claude.json');
	pretrustDirectoryForAgent('codex', '/tmp/worktree/STA-401', configPath);

	// Writing Claude's trust file on Codex's behalf would be meaningless, so
	// the file must not be created at all.
	t.throws(() => readFileSync(configPath, 'utf-8'));
});

test('pretrustDirectoryForAgent leaves an existing Claude config untouched for Codex', t => {
	const configPath = join(
		mkdtempSync(join(tmpdir(), 'papp-trust-')),
		'.claude.json',
	);
	writeFileSync(configPath, JSON.stringify({projects: {}, other: 'keep'}));

	pretrustDirectoryForAgent('codex', '/tmp/worktree/STA-402', configPath);

	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.deepEqual(config, {projects: {}, other: 'keep'});
});

// Tier-3 liveness fallback: the floor of the adapter contract, and the safety
// net when ~/.pappardelle/agent-status/ is missing entirely.

test('isAgentForegroundInSession reports the agent as running when it owns the pane', t => {
	const session = getSessionNames('STA-500', 'my-repo').claude;
	const commands = new Map([[session, 'claude']]);
	t.true(isAgentForegroundInSession('claude', 'STA-500', commands, 'my-repo'));
});

test('isAgentForegroundInSession is false when a shell owns the pane', t => {
	const session = getSessionNames('STA-501', 'my-repo').claude;
	const commands = new Map([[session, 'zsh']]);
	t.false(isAgentForegroundInSession('claude', 'STA-501', commands, 'my-repo'));
});

test('isAgentForegroundInSession is false when the session has no live pane', t => {
	t.false(
		isAgentForegroundInSession('claude', 'STA-502', new Map(), 'my-repo'),
	);
});

test('isAgentForegroundInSession does not mistake one harness for another', t => {
	// A Codex space whose session is somehow running claude must not read as a
	// live Codex session — same guard as the status file's `agent` field, at
	// the liveness tier.
	const session = getSessionNames('STA-503', 'my-repo').claude;
	t.false(
		isAgentForegroundInSession(
			'codex',
			'STA-503',
			new Map([[session, 'claude']]),
			'my-repo',
		),
	);
	t.true(
		isAgentForegroundInSession(
			'codex',
			'STA-503',
			new Map([[session, 'codex']]),
			'my-repo',
		),
	);
});

test('getInnerSessionForegroundCommands never throws, even with no tmux server', t => {
	t.notThrows(() => getInnerSessionForegroundCommands());
	t.true(getInnerSessionForegroundCommands() instanceof Map);
});
