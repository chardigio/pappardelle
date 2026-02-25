import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	getSessionNames,
	extractIssueKeyFromSession,
	getSessionPrefix,
	pretrustDirectoryForClaude,
} from './tmux.ts';

// getSessionPrefix: returns repo-qualified prefix
test('getSessionPrefix includes repo name for claude', t => {
	const prefix = getSessionPrefix('claude', 'pappa-chex');
	t.is(prefix, 'claude-pappa-chex-');
});

test('getSessionPrefix includes repo name for lazygit', t => {
	const prefix = getSessionPrefix('lazygit', 'pappa-chex');
	t.is(prefix, 'lazygit-pappa-chex-');
});

// getSessionNames: repo-qualified session names
test('getSessionNames qualifies issue key with repo name', t => {
	const names = getSessionNames('CHEX-313', 'pappa-chex');
	t.is(names.claude, 'claude-pappa-chex-CHEX-313');
	t.is(names.lazygit, 'lazygit-pappa-chex-CHEX-313');
});

test('getSessionNames qualifies main branch with repo name', t => {
	const names = getSessionNames('main', 'pappa-chex');
	t.is(names.claude, 'claude-pappa-chex-main');
	t.is(names.lazygit, 'lazygit-pappa-chex-main');
});

test('getSessionNames works with different repo names', t => {
	const names = getSessionNames('STA-100', 'stardust-labs');
	t.is(names.claude, 'claude-stardust-labs-STA-100');
	t.is(names.lazygit, 'lazygit-stardust-labs-STA-100');
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
