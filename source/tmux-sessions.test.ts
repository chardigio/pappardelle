import test from 'ava';
import {
	getSessionNames,
	extractIssueKeyFromSession,
	getSessionPrefix,
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
