import React from 'react';
import {Text, useInput} from 'ink';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {
	isCloseSpaceKey,
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
// isCloseSpaceKey
// ============================================================================

test('x closes the selected space', t => {
	t.true(isCloseSpaceKey('x', {}));
});

test('Backspace closes the selected space', t => {
	t.true(isCloseSpaceKey('', {backspace: true}));
});

test('forward delete (fn+Delete) closes the selected space', t => {
	t.true(isCloseSpaceKey('', {delete: true}));
});

test('other keys do not close the selected space', t => {
	t.false(isCloseSpaceKey('X', {}));
	t.false(isCloseSpaceKey('n', {}));
	t.false(isCloseSpaceKey('', {}));
});

// STA-2573: Ink 4 named the Mac Backspace byte (\x7f) `delete`, and Ink 7 names
// it `backspace`. The rail only checked `key.delete`, so the upgrade silently
// unbound Backspace. Drive the real bytes through Ink's own parser so the next
// Ink upgrade can't move them again unnoticed.
async function closesSpaceOnStdin(bytes: string): Promise<boolean> {
	let closed = false;
	function Rail() {
		useInput((input, key) => {
			if (isCloseSpaceKey(input, key)) closed = true;
		});
		return React.createElement(Text, null, 'rail');
	}

	const view = render(React.createElement(Rail));
	try {
		await delay(10);
		view.stdin.write(bytes);
		await delay(20);
		return closed;
	} finally {
		view.unmount();
	}
}

test('Ink delivers the Backspace byte as a close-space key', async t => {
	t.true(await closesSpaceOnStdin('\x7f'));
});

test('Ink delivers ctrl+h backspace as a close-space key', async t => {
	t.true(await closesSpaceOnStdin('\b'));
});

test('Ink delivers fn+Delete as a close-space key', async t => {
	t.true(await closesSpaceOnStdin('\x1b[3~'));
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
