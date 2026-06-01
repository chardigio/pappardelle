/**
 * Pure helpers for ConfirmDialog. Extracted so the dialog's behavior can be
 * unit-tested without rendering React/Ink — the .tsx file itself can't be
 * loaded by the bare-node + `--experimental-strip-types` test setup.
 */

export type ConfirmAction = 'confirm' | 'cancel' | 'ignore';

/**
 * Map a keystroke to an action. While `isProcessing` is true the dialog has
 * already accepted a confirm and is waiting on the async work to finish, so
 * every further keystroke is swallowed — that's what makes the "loading"
 * window unambiguous (no accidental re-cancel, no second confirm).
 */
export function parseConfirmDialogInput(
	input: string,
	key: {escape?: boolean; return?: boolean},
	isProcessing: boolean,
): ConfirmAction {
	if (isProcessing) return 'ignore';
	if (key.escape || input === 'n' || input === 'N') return 'cancel';
	if (key.return || input === 'y' || input === 'Y') return 'confirm';
	return 'ignore';
}

/**
 * Detect a thenable so the dialog can switch into its loading state only
 * when `onConfirm` is actually async. A sync `onConfirm` collapses
 * instantly, so showing a spinner for it would just flicker.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as {then?: unknown}).then === 'function'
	);
}

/**
 * Run `onConfirm` and absorb any rejection / sync throw so the dialog never
 * produces an unhandled-promise-rejection crash. Parent code is the right
 * place to surface errors to the user (`setHeaderWithTimeout` on the
 * delete-workspace path already does so); the dialog only needs to make sure
 * the discarded promise doesn't terminate the process in Node 15+. Returns
 * the original promise so the caller can still inspect `isThenable(result)`
 * to decide whether to enter the loading state.
 */
export function runConfirmSafely(
	onConfirm: () => void | PromiseLike<void>,
): void | PromiseLike<void> {
	try {
		const result = onConfirm();
		if (isThenable(result)) {
			// Cast through Promise.resolve so we can use .catch (xo prefers
			// .catch over .then(undefined, fn)). Resolving with an existing
			// thenable returns the same thenable's tracked state.
			Promise.resolve(result).catch(() => {});
		}
		return result;
	} catch {
		return undefined;
	}
}
