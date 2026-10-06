import {isPopupAvailable, openPopup} from './host.ts';

export type IssueViewer = (argv: string[], title: string) => Promise<boolean>;

// Resolves once the popup is launched rather than when it closes, so a caller's
// "Showing X" message appears while the issue is on screen.
const openInPopup: IssueViewer = async (argv, title) => {
	if (!isPopupAvailable()) return false;
	void openPopup({kind: 'issue', props: {argv, title}});
	return true;
};

let viewer: IssueViewer = openInPopup;

/**
 * Show a command's output (e.g. `bd show`) to the user. The TUI opens it in a
 * tmux popup. Inside a popup, where tmux won't stack a second one, the popup
 * child swaps in a viewer that shows it in place.
 */
export async function viewIssue(
	argv: string[],
	title: string,
): Promise<boolean> {
	return viewer(argv, title);
}

export function setIssueViewer(next: IssueViewer): () => void {
	const previous = viewer;
	viewer = next;
	return () => {
		viewer = previous;
	};
}
