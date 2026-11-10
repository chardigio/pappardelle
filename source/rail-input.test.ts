import {useKeyboard} from '@opentui/react';
import {shortcutKey} from './tui-key.ts';
import React from 'react';
import {render} from '../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {
	isCloseSpaceKey,
	isFocusAgentKey,
	isRailInputBlocked,
	type RailDialogState,
} from './rail-input.ts';

// ============================================================================
// isFocusAgentKey
// ============================================================================

test('Enter focuses the Claude pane', t => {
	t.true(isFocusAgentKey({return: true}));
});

test('plain right arrow focuses the Claude pane', t => {
	t.true(isFocusAgentKey({rightArrow: true}));
});

test('other arrows do not focus the Claude pane', t => {
	t.false(isFocusAgentKey({}));
});

test('modified right arrows do not focus the Claude pane', t => {
	t.false(isFocusAgentKey({rightArrow: true, meta: true}));
	t.false(isFocusAgentKey({rightArrow: true, shift: true}));
	t.false(isFocusAgentKey({rightArrow: true, ctrl: true}));
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

// STA-2573: a framework upgrade once renamed the Mac Backspace byte (\x7f) from
// `delete` to `backspace` while the rail only checked `key.delete`, silently
// unbinding Backspace. Drive the real bytes through OpenTUI's parser so a
// renamed key fails here.
async function closesSpaceOnStdin(bytes: string): Promise<boolean> {
	let closed = false;
	function Rail() {
		useKeyboard(event => {
			const {input, key} = shortcutKey(event);
			if (isCloseSpaceKey(input, key)) closed = true;
		});
		return React.createElement('text', null, 'rail');
	}

	const view = await render(React.createElement(Rail));
	try {
		await delay(10);
		await view.stdin.write(bytes);
		await delay(20);
		return closed;
	} finally {
		await view.unmount();
	}
}

test('OpenTUI delivers the Backspace byte as a close-space key', async t => {
	t.true(await closesSpaceOnStdin('\x7f'));
});

test('OpenTUI delivers ctrl+h backspace as a close-space key', async t => {
	t.true(await closesSpaceOnStdin('\b'));
});

test('OpenTUI delivers fn+Delete as a close-space key', async t => {
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
	showConfigMigration: false,
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
	['config migration', {showConfigMigration: true}],
];

for (const [name, patch] of openDialogs) {
	test(`rail input is blocked while the ${name} dialog is open`, t => {
		t.true(isRailInputBlocked({...closed, ...patch}));
	});
}
