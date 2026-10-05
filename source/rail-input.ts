/**
 * Pure helpers for the issue rail's input handler in app.tsx. Extracted so the
 * key handling can be unit-tested without rendering React/Ink — the .tsx file
 * itself can't be loaded by the bare-node + `--experimental-strip-types` test
 * setup.
 */

export type FocusClaudeKey = {
	return?: boolean;
	rightArrow?: boolean;
	meta?: boolean;
	shift?: boolean;
	ctrl?: boolean;
};

/**
 * Enter or a plain right arrow moves focus into the Claude viewer pane.
 * Modified right arrows are left unbound for future shortcuts.
 */
export function isFocusClaudeKey(key: FocusClaudeKey): boolean {
	if (key.return) return true;
	return Boolean(key.rightArrow && !key.meta && !key.shift && !key.ctrl);
}

export type CloseSpaceKey = {
	backspace?: boolean;
	delete?: boolean;
};

/**
 * Backspace, forward delete, or `x` asks to close the selected space.
 *
 * Both Backspace and Delete are checked because Ink has moved the Mac
 * Backspace byte (`\x7f`) between them: Ink 4 named it `delete`, Ink 7 names
 * it `backspace`. Checking only one of them silently unbound the key after the
 * Ink 7 upgrade (STA-2573).
 */
export function isCloseSpaceKey(input: string, key: CloseSpaceKey): boolean {
	return Boolean(key.backspace || key.delete || input === 'x');
}

export type RailDialogState = {
	showPromptDialog: boolean;
	showDeleteConfirm: boolean;
	killDoneTargets: readonly unknown[] | null;
	showUpdateConfirm: boolean;
	showHelp: boolean;
	showErrorDialog: boolean;
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
		state.showErrorDialog
	);
}
