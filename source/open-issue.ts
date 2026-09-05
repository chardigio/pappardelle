import {spawn} from 'node:child_process';
import {createIssueTracker} from './providers/index.ts';
import type {IssueTrackerProvider} from './providers/types.ts';

/** The slice of the provider this needs, so callers can stub it in tests. */
type OpenableTracker = Pick<IssueTrackerProvider, 'buildIssueUrl'> &
	Partial<Pick<IssueTrackerProvider, 'openIssue'>>;

export interface OpenIssueDeps {
	createTracker?: () => OpenableTracker;
	openUrl?: (url: string) => void;
}

export interface OpenIssueResult {
	ok: boolean;
	/** Ready to hand straight to a header or an inline error line. */
	message: string;
}

function launchBrowser(url: string): void {
	const child = spawn('open', [url], {detached: true, stdio: 'ignore'});

	child.on('error', () => {});
	child.unref();
}

/**
 * Show an issue to the user, wherever that tracker's issues live.
 */
export function openIssueForKey(
	issueKey: string,
	deps: OpenIssueDeps = {},
): OpenIssueResult {
	const createTracker = deps.createTracker ?? createIssueTracker;
	const openUrl = deps.openUrl ?? launchBrowser;

	try {
		const tracker = createTracker();
		if (tracker.openIssue) {
			return tracker.openIssue(issueKey)
				? {ok: true, message: `Showing ${issueKey}`}
				: {ok: false, message: 'Cannot show issue outside tmux'};
		}

		openUrl(tracker.buildIssueUrl(issueKey));
		return {ok: true, message: `Opened ${issueKey}`};
	} catch {
		return {ok: false, message: 'Failed to look up issue'};
	}
}
