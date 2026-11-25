import {test, expect} from 'bun:test';
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

test('Enter focuses the Claude pane', () => {
	expect(isFocusAgentKey(press('return'))).toBe(true);
});

test('plain right arrow focuses the Claude pane', () => {
	expect(isFocusAgentKey(press('right'))).toBe(true);
});

test('other arrows do not focus the Claude pane', () => {
	expect(isFocusAgentKey(press('left'))).toBe(false);
	expect(isFocusAgentKey(press('up'))).toBe(false);
});

test('modified right arrows do not focus the Claude pane', () => {
	expect(isFocusAgentKey(press('right', {meta: true}))).toBe(false);
	expect(isFocusAgentKey(press('right', {shift: true}))).toBe(false);
	expect(isFocusAgentKey(press('right', {ctrl: true}))).toBe(false);
});

test('OpenTUI delivers Alt+Right as a modified right arrow', async () => {
	const [key] = await keysFromStdin('\x1b[1;3C');
	expect(key !== undefined && isFocusAgentKey({...key, meta: false})).toBe(
		true,
	);
	expect(key !== undefined && isFocusAgentKey(key)).toBe(false);
});

// ============================================================================
// isCloseSpaceKey
// ============================================================================

test('x closes the selected space', () => {
	expect(isCloseSpaceKey(press('x'))).toBe(true);
});

test('Backspace closes the selected space', () => {
	expect(isCloseSpaceKey(press('backspace'))).toBe(true);
});

test('forward delete (fn+Delete) closes the selected space', () => {
	expect(isCloseSpaceKey(press('delete'))).toBe(true);
});

test('other keys do not close the selected space', () => {
	expect(isCloseSpaceKey(press('x', {shift: true}))).toBe(false);
	expect(isCloseSpaceKey(press('x', {ctrl: true}))).toBe(false);
	expect(isCloseSpaceKey(press('n'))).toBe(false);
	expect(isCloseSpaceKey(press('return'))).toBe(false);
});

// STA-2573: a framework upgrade once renamed the Mac Backspace byte (\x7f) from
// `delete` to `backspace` while the rail only checked `key.delete`, silently
// unbinding Backspace. Drive the real bytes through OpenTUI's parser so a
// renamed key fails here.
async function closesSpaceOnStdin(bytes: string): Promise<boolean> {
	const [key] = await keysFromStdin(bytes);
	return key !== undefined && isCloseSpaceKey(key);
}

test('OpenTUI delivers the Backspace byte as a close-space key', async () => {
	expect(await closesSpaceOnStdin('\x7f')).toBe(true);
});

test('OpenTUI delivers ctrl+h backspace as a close-space key', async () => {
	expect(await closesSpaceOnStdin('\b')).toBe(true);
});

test('OpenTUI delivers fn+Delete as a close-space key', async () => {
	expect(await closesSpaceOnStdin('\x1b[3~')).toBe(true);
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

test('rail input is live with every dialog closed', () => {
	expect(isRailInputBlocked(closed)).toBe(false);
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
	test(`rail input is blocked while the ${name} dialog is open`, () => {
		expect(isRailInputBlocked({...closed, ...patch})).toBe(true);
	});
}
