import test from 'ava';
import {press} from '../test/helpers/key-press.ts';
import {keysFromStdin} from '../test/helpers/render.ts';
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
	t.true(isFocusAgentKey(press('return')));
});

test('plain right arrow focuses the Claude pane', t => {
	t.true(isFocusAgentKey(press('right')));
});

test('other arrows do not focus the Claude pane', t => {
	t.false(isFocusAgentKey(press('left')));
	t.false(isFocusAgentKey(press('up')));
});

test('modified right arrows do not focus the Claude pane', t => {
	t.false(isFocusAgentKey(press('right', {meta: true})));
	t.false(isFocusAgentKey(press('right', {shift: true})));
	t.false(isFocusAgentKey(press('right', {ctrl: true})));
});

test('OpenTUI delivers Alt+Right as a modified right arrow', async t => {
	const [key] = await keysFromStdin('\x1b[1;3C');
	t.true(key !== undefined && isFocusAgentKey({...key, meta: false}));
	t.false(key !== undefined && isFocusAgentKey(key));
});

// ============================================================================
// isCloseSpaceKey
// ============================================================================

test('x closes the selected space', t => {
	t.true(isCloseSpaceKey(press('x')));
});

test('Backspace closes the selected space', t => {
	t.true(isCloseSpaceKey(press('backspace')));
});

test('forward delete (fn+Delete) closes the selected space', t => {
	t.true(isCloseSpaceKey(press('delete')));
});

test('other keys do not close the selected space', t => {
	t.false(isCloseSpaceKey(press('x', {shift: true})));
	t.false(isCloseSpaceKey(press('x', {ctrl: true})));
	t.false(isCloseSpaceKey(press('n')));
	t.false(isCloseSpaceKey(press('return')));
});

// STA-2573: a framework upgrade once renamed the Mac Backspace byte (\x7f) from
// `delete` to `backspace` while the rail only checked `key.delete`, silently
// unbinding Backspace. Drive the real bytes through OpenTUI's parser so a
// renamed key fails here.
async function closesSpaceOnStdin(bytes: string): Promise<boolean> {
	const [key] = await keysFromStdin(bytes);
	return key !== undefined && isCloseSpaceKey(key);
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
