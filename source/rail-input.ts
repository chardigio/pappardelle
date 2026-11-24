/**
 * Pure helpers for the issue rail's input handler in app.tsx, so the key rules
 * can be tested without mounting the app.
 */

import {typedText, type KeyPress} from './key-press.ts';

/**
 * Enter or a plain right arrow moves focus into the Claude viewer pane.
 * Modified right arrows are left unbound for future shortcuts.
 */
export function isFocusAgentKey(key: KeyPress): boolean {
	if (key.name === 'return') return true;
	return key.name === 'right' && !key.meta && !key.shift && !key.ctrl;
}

/**
 * Backspace, forward delete, or `x` asks to close the selected space.
 *
 * OpenTUI names the Mac Backspace byte (`\x7f`) and ctrl+h `backspace`, and
 * fn+Delete (`\x1b[3~`) `delete`, so both names are checked. Ink once moved
 * `\x7f` from `delete` to `backspace`, which silently unbound the key while
 * only one name was checked (STA-2573).
 */
export function isCloseSpaceKey(key: KeyPress): boolean {
	return (
		key.name === 'backspace' || key.name === 'delete' || typedText(key) === 'x'
	);
}

export type RailDialogState = {
	showPromptDialog: boolean;
	showDeleteConfirm: boolean;
	killDoneTargets: readonly unknown[] | null;
	showUpdateConfirm: boolean;
	showHelp: boolean;
	showErrorDialog: boolean;
	showConfigMigration: boolean;
};

/**
 * Open dialogs handle their own input, so the rail must ignore keystrokes
 * while any of them is showing.
 */
export function isRailInputBlocked(state: RailDialogState): boolean {
	return (
		state.showPromptDialog ||
		state.showDeleteConfirm ||
		state.killDoneTargets !== null ||
		state.showUpdateConfirm ||
		state.showHelp ||
		state.showErrorDialog ||
		state.showConfigMigration
	);
}
