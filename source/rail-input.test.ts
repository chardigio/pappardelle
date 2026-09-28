import test from 'ava';
import {
	isFocusClaudeKey,
	isRailInputBlocked,
	type RailDialogState,
} from './rail-input.ts';

// ============================================================================
// isFocusClaudeKey
// ============================================================================

test('Enter focuses the Claude pane', t => {
	t.true(isFocusClaudeKey({return: true}));
});

test('plain right arrow focuses the Claude pane', t => {
	t.true(isFocusClaudeKey({rightArrow: true}));
});

test('other arrows do not focus the Claude pane', t => {
	t.false(isFocusClaudeKey({}));
});

test('modified right arrows do not focus the Claude pane', t => {
	t.false(isFocusClaudeKey({rightArrow: true, meta: true}));
	t.false(isFocusClaudeKey({rightArrow: true, shift: true}));
	t.false(isFocusClaudeKey({rightArrow: true, ctrl: true}));
});

// ============================================================================
// isRailInputBlocked
// ============================================================================

const closed: RailDialogState = {
	showPromptDialog: false,
	showDeleteConfirm: false,
	killDoneTargets: null,
	showUpdateConfirm: false,
	showHelp: false,
	showErrorDialog: false,
};

test('rail input is live with every dialog closed', t => {
	t.false(isRailInputBlocked(closed));
});

const openDialogs: Array<[string, Partial<RailDialogState>]> = [
	['prompt', {showPromptDialog: true}],
	['delete confirm', {showDeleteConfirm: true}],
	['kill-done confirm', {killDoneTargets: ['STA-1']}],
	['kill-done confirm with no targets', {killDoneTargets: []}],
	['update confirm', {showUpdateConfirm: true}],
	['help', {showHelp: true}],
	['error', {showErrorDialog: true}],
];

for (const [name, patch] of openDialogs) {
	test(`rail input is blocked while the ${name} dialog is open`, t => {
		t.true(isRailInputBlocked({...closed, ...patch}));
	});
}
