// Pure logic for determining how to spawn an idow session
// Extracted from handleNewSession in app.tsx for testability

export type SessionRoute = {
	type: 'issue' | 'description';
	/** Issue key for issue routes, null for description routes */
	issueKey: string | null;
	/** Title shown in the pending list row (e.g., "Resuming..." or "Starting new session...") */
	pendingTitle: string;
};

/**
 * Given a normalized issue key (or null), determine the route type
 * and pending row metadata.
 *
 * Key behavior: when the input is an issue key, the caller passes
 * just the issue key to idow — never --resume or other flags.
 * The idow script handles both new and existing issues correctly
 * with a bare issue key.
 */
export function routeSession(normalizedIssueKey: string | null): SessionRoute {
	if (normalizedIssueKey) {
		return {
			type: 'issue',
			issueKey: normalizedIssueKey,
			pendingTitle: 'Resuming\u2026',
		};
	}

	return {
		type: 'description',
		issueKey: null,
		pendingTitle: 'Starting new session\u2026',
	};
}

/**
 * Pending session state for rendering a placeholder row in the list.
 * Set when a session is spawned, cleared when the real space appears.
 */
export interface PendingSession {
	type: 'issue' | 'description';
	/** Issue key for issue routes (e.g., "STA-477"), empty string for description routes */
	name: string;
	/** The idow argument to spawn with */
	idowArg: string;
	/** Title shown in the pending list row */
	pendingTitle: string;
	/** Space count at the time the session was started (for description routes) */
	prevSpaceCount: number;
}

/**
 * Check if a pending session should be cleared because
 * the space it refers to now exists in the spaces list.
 *
 * For issue-key sessions, resolves when that key appears in spaceNames.
 * For description sessions, resolves when the space count grows beyond prevSpaceCount.
 */
export function isPendingSessionResolved(
	pending: PendingSession,
	spaceNames: string[],
): boolean {
	if (pending.type === 'description') {
		return spaceNames.length > pending.prevSpaceCount;
	}

	return spaceNames.includes(pending.name);
}
