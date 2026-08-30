// Presentation helpers for the built-in `K` shortcut, which closes every
// workspace whose tracker issue has reached a terminal state (STA-2111).
//
// `K` is the on-demand counterpart to `auto_remove_when_done: true`. Both
// close the same set of spaces, chosen by the same `findDoneSpaces` predicate,
// through the same `deleteSpace` path. The flag does it silently as each issue
// lands; `K` waits for the user to ask, so a user who wants the rail to stay
// put until the user says otherwise still has a one-key way to clear it out.
export {findDoneSpaces} from './auto-remove.ts';

/** Header copy shown when `K` finds nothing to close. */
export const KILL_DONE_EMPTY_MESSAGE = 'No done or canceled spaces';

export interface KillDoneConfirmContent {
	title: string;
	message: string;
	detail: string;
	processingMessage: string;
}

/**
 * Build the confirm-dialog copy for a batch of `count` spaces.
 *
 * The dialog reports a count rather than a name list: the batch is unbounded,
 * and a rail with a dozen finished tickets would push the dialog past the
 * height of a short pane. The names are already visible on the rail behind it.
 */
export function buildKillDoneConfirmContent(
	count: number,
): KillDoneConfirmContent {
	const noun = count === 1 ? 'space' : 'spaces';
	return {
		title: 'Close Done Spaces',
		message: `Close ${count} done/canceled ${noun}?`,
		detail: 'The worktrees and git branches will remain on disk.',
		processingMessage: `Closing ${count} ${noun}…`,
	};
}

/**
 * Build the header message for a finished batch.
 *
 * A partial result gets its own wording because a silent shortfall is the
 * dangerous case: `deleteSpace` returns false when a `pre_workspace_deinit`
 * hook fails, and the user must see that some spaces are still on the rail on
 * purpose.
 */
export function formatKillDoneResult(closed: number, total: number): string {
	if (closed === total) {
		return `Closed ${closed} ${closed === 1 ? 'space' : 'spaces'}`;
	}
	const failed = total - closed;
	return `Closed ${closed} of ${total} spaces (${failed} failed)`;
}
