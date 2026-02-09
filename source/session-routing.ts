// Pure logic for determining how to spawn an idow session
// Extracted from handleNewSession in app.tsx for testability

const STARTING_PREFIX = 'starting ';
const STARTING_NEW_SESSION = 'starting new session';

export type SessionRoute = {
	type: 'issue' | 'description';
	args: string[];
	statusStart: string;
};

/**
 * Given a normalized issue key (or null) and the original input,
 * determine the idow arguments and status messages.
 *
 * Key behavior: when the input is an issue key, always pass just the
 * issue key to idow — never --resume or other flags. The idow script
 * handles both new and existing issues correctly with a bare issue key.
 */
export function routeSession(
	normalizedIssueKey: string | null,
	originalInput: string,
): SessionRoute {
	if (normalizedIssueKey) {
		return {
			type: 'issue',
			args: [normalizedIssueKey],
			statusStart: `starting ${normalizedIssueKey}`,
		};
	}

	return {
		type: 'description',
		args: [originalInput],
		statusStart: STARTING_NEW_SESSION,
	};
}

/**
 * Check if a "starting ..." status message should be cleared because
 * the space it refers to now exists in the spaces list.
 *
 * For issue-key sessions ("starting STA-464"), resolves when that key
 * appears in spaceNames.  For description sessions ("starting new session"),
 * resolves when the space count grows beyond prevSpaceCount.
 */
export function isStartingStatusResolved(
	statusMessage: string,
	spaceNames: string[],
	prevSpaceCount: number,
): boolean {
	if (!statusMessage.startsWith(STARTING_PREFIX)) return false;

	if (statusMessage === STARTING_NEW_SESSION) {
		return spaceNames.length > prevSpaceCount;
	}

	// Extract the issue key after "starting "
	const issueKey = statusMessage.slice(STARTING_PREFIX.length);
	return spaceNames.includes(issueKey);
}
