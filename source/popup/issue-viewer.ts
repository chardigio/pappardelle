import {isPopupAvailable, openPopup} from './host.ts';

/**
 * Show a command's output (e.g. `bd show`) in a tmux popup. Resolves once the
 * popup is launched rather than when it closes, so a caller's "Showing X"
 * message appears while the issue is on screen.
 */
export async function viewIssue(
	argv: string[],
	title: string,
): Promise<boolean> {
	if (!isPopupAvailable()) return false;
	void openPopup({kind: 'issue', props: {argv, title}});
	return true;
}
