// Pure logic for determining how to spawn an idow session
// Extracted from handleNewSession in app.tsx for testability
// Pure logic for determining how to spawn an idow session.
export type SessionRoute = {
	type: 'issue' | 'description';
	args: string[];
	statusStart: string;
	statusSuccess: string;
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
			statusStart: `Starting ${normalizedIssueKey}...`,
			statusSuccess: `Opened ${normalizedIssueKey}`,
		};
	}

	return {
		type: 'description',
		args: [originalInput],
		statusStart: 'Starting new IDOW session...',
		statusSuccess: 'IDOW session started!',
	};
}
