/**
 * Pure helpers for the issue rail's input handler in app.tsx, so the key rules
 * can be tested without mounting the app.
 */

export type FocusAgentKey = {
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
export function isFocusAgentKey(key: FocusAgentKey): boolean {
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
 * OpenTUI names the Mac Backspace byte (`\x7f`) and ctrl+h `backspace`, and
 * fn+Delete (`\x1b[3~`) `delete`, so both names are checked. Ink once moved
 * `\x7f` from `delete` to `backspace`, which silently unbound the key while
 * only one name was checked (STA-2573).
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
